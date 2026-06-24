"""Server-side password-reset tokens (opaque, single-use, expiring).

The "forgot password" flow hands the user an opaque high-entropy token by email;
presenting it back at ``/auth/reset-password`` lets them set a new password
without their old one. The design mirrors :mod:`app.core.refresh_tokens`:

* The token handed to the user is an opaque secret. We never store it; we store
  only its SHA-256 hash mapped to the owning user. A store compromise therefore
  does not leak usable reset tokens.
* It is **single-use**: ``consume`` atomically reads and deletes the record, so a
  given reset link works exactly once. A replayed/already-used link fails.
* It is short-lived (``password_reset_ttl_minutes``), so a leaked link stops
  working quickly even if it is never used.

Backends mirror ``refresh_tokens``: per-process memory for dev/tests, Redis for
prod (shared across replicas, auto-expiring). Both fail safe - a store error on
consume means the reset is rejected (the user requests a new link), never
silently accepted.
"""
from __future__ import annotations

import hashlib
import json
import logging
import secrets
import time
from dataclasses import dataclass
from threading import Lock
from typing import Protocol

logger = logging.getLogger(__name__)

_KEY_PREFIX = "pb:pwreset:"
# Opaque token entropy. 32 bytes -> 43-char urlsafe string, ~256 bits.
_TOKEN_BYTES = 32


@dataclass(frozen=True)
class ResetRecord:
    user_id: str
    tenant_id: str
    email: str


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class _Backend(Protocol):
    def store(self, token_hash: str, payload: str, ttl_seconds: int) -> None: ...
    def consume(self, token_hash: str) -> str | None: ...
    def discard(self, token_hash: str) -> None: ...


class _MemoryBackend:
    def __init__(self) -> None:
        self._entries: dict[str, tuple[str, float]] = {}
        self._lock = Lock()

    def store(self, token_hash: str, payload: str, ttl_seconds: int) -> None:
        with self._lock:
            self._entries[token_hash] = (payload, time.time() + max(0, ttl_seconds))
            self._sweep_locked()

    def consume(self, token_hash: str) -> str | None:
        with self._lock:
            self._sweep_locked()
            entry = self._entries.pop(token_hash, None)
            return entry[0] if entry else None

    def discard(self, token_hash: str) -> None:
        with self._lock:
            self._entries.pop(token_hash, None)

    def _sweep_locked(self) -> None:
        now = time.time()
        for k in [k for k, (_, exp) in self._entries.items() if exp <= now]:
            del self._entries[k]


class _RedisBackend:
    def __init__(self, client) -> None:  # type: ignore[no-untyped-def]
        self._client = client

    def store(self, token_hash: str, payload: str, ttl_seconds: int) -> None:
        if ttl_seconds <= 0:
            return
        self._client.set(_KEY_PREFIX + token_hash, payload, ex=ttl_seconds)

    def consume(self, token_hash: str) -> str | None:
        # GETDEL is atomic (Redis 6.2+/ElastiCache): the token is read and
        # invalidated in one round trip so it cannot be consumed twice even under
        # concurrent resets.
        try:
            return self._client.getdel(_KEY_PREFIX + token_hash)
        except AttributeError:  # very old client without getdel
            pipe = self._client.pipeline()
            pipe.get(_KEY_PREFIX + token_hash)
            pipe.delete(_KEY_PREFIX + token_hash)
            value, _ = pipe.execute()
            return value

    def discard(self, token_hash: str) -> None:
        try:
            self._client.delete(_KEY_PREFIX + token_hash)
        except Exception as exc:  # noqa: BLE001
            logger.warning("pwreset_discard_redis_unreachable", extra={"error": str(exc)})


_backend: _Backend | None = None


def _get_backend() -> _Backend:
    global _backend
    if _backend is not None:
        return _backend
    from app.config import get_settings

    settings = get_settings()
    choice = (settings.refresh_token_backend or "").strip().lower()
    if not choice:
        choice = "redis" if settings.environment.lower() in {"prod", "production"} else "memory"
    if choice == "redis":
        _backend = _build_redis_backend(settings)
    else:
        _backend = _MemoryBackend()
    return _backend


def _build_redis_backend(settings) -> _Backend:
    try:
        import redis  # type: ignore

        from app.core.redis_security import redis_ssl_options

        client = redis.Redis.from_url(
            settings.redis_url, decode_responses=True,
            **redis_ssl_options(settings.redis_url, settings),
        )
        client.ping()
        return _RedisBackend(client)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "password_reset_redis_unavailable_falling_back_to_memory",
            extra={"error": str(exc)},
        )
        return _MemoryBackend()


def issue(*, user_id: str, tenant_id: str, email: str, ttl_seconds: int) -> str:
    """Mint a new opaque reset token bound to the user, store its hash, and
    return the raw token to email to the user (never stored or logged)."""
    token = secrets.token_urlsafe(_TOKEN_BYTES)
    payload = json.dumps({"user_id": user_id, "tenant_id": tenant_id, "email": email})
    try:
        _get_backend().store(_hash(token), payload, ttl_seconds)
    except Exception as exc:  # noqa: BLE001
        # Fail closed: if we cannot persist the token we must not hand one out,
        # otherwise the user would hold a reset link the server can't honour.
        logger.error("pwreset_issue_failed", extra={"error": str(exc)})
        raise
    return token


def consume(token: str) -> ResetRecord | None:
    """Atomically validate + invalidate a reset token (single use). Returns the
    owning record, or None if the token is unknown/expired/already used."""
    if not token:
        return None
    try:
        raw = _get_backend().consume(_hash(token))
    except Exception as exc:  # noqa: BLE001
        logger.warning("pwreset_consume_failed", extra={"error": str(exc)})
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return ResetRecord(
            user_id=data["user_id"],
            tenant_id=data["tenant_id"],
            email=data["email"],
        )
    except (ValueError, KeyError, TypeError):
        return None


def reset_for_tests() -> None:
    global _backend
    _backend = None
