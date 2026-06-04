"""Server-side ``turn_id -> [chunk_id]`` attribution cache for the retrieval
re-ranking loop (slice 3 of the learning loop).

When a chat turn retrieves chunks, the orchestrator pushes the (tenant_id,
turn_id, chunk_ids) tuple here. When the user later thumbs-up / thumbs-down
the turn, the feedback route looks up the chunk_ids and asks the chunk-
weights repository to bump them.

Why server-side instead of having the client echo chunk_ids back on feedback:
trusting the client means a malicious user could target arbitrary chunks
(including a safety SOP they want to bury). The attribution cache scopes
weight updates to chunks the server actually retrieved for that turn.

Backends:
  * memory: per-process dict with timestamps, swept on read. Right for dev
    and tests; not shared across uvicorn workers / ECS tasks, but a missed
    attribution just means a feedback row without weight update - no error.
  * redis: ``SET key json ex <ttl>`` per (tenant, turn). Shared across
    replicas; auto-expires per ``chunk_attribution_ttl_seconds`` so memory
    doesn't grow unbounded as old feedback ages out.

Falls open: any backend error returns an empty chunk list rather than
throwing. The learning loop degrades; the chat path stays alive.
"""
from __future__ import annotations

import json
import logging
import time
from threading import Lock
from typing import Protocol

logger = logging.getLogger(__name__)

_KEY_PREFIX = "pb:attrib:"


class _Backend(Protocol):
    def remember(self, tenant_id: str, turn_id: str, chunk_ids: list[int], ttl: int) -> None: ...
    def recall(self, tenant_id: str, turn_id: str) -> list[int]: ...


class _MemoryBackend:
    def __init__(self) -> None:
        self._entries: dict[str, tuple[float, list[int]]] = {}
        self._lock = Lock()

    def remember(self, tenant_id: str, turn_id: str, chunk_ids: list[int], ttl: int) -> None:
        key = self._key(tenant_id, turn_id)
        with self._lock:
            self._sweep_locked()
            self._entries[key] = (time.time() + max(0, ttl), list(chunk_ids))

    def recall(self, tenant_id: str, turn_id: str) -> list[int]:
        key = self._key(tenant_id, turn_id)
        with self._lock:
            self._sweep_locked()
            entry = self._entries.get(key)
            return list(entry[1]) if entry else []

    def _sweep_locked(self) -> None:
        now = time.time()
        for k in [k for k, (exp, _) in self._entries.items() if exp <= now]:
            del self._entries[k]

    @staticmethod
    def _key(tenant_id: str, turn_id: str) -> str:
        return f"{tenant_id}|{turn_id}"


class _RedisBackend:
    def __init__(self, client) -> None:  # type: ignore[no-untyped-def]
        self._client = client

    def remember(self, tenant_id: str, turn_id: str, chunk_ids: list[int], ttl: int) -> None:
        if ttl <= 0 or not chunk_ids:
            return
        try:
            self._client.set(
                self._key(tenant_id, turn_id),
                json.dumps([int(c) for c in chunk_ids]),
                ex=ttl,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("attribution_remember_redis_unreachable", extra={"error": str(exc)})

    def recall(self, tenant_id: str, turn_id: str) -> list[int]:
        try:
            raw = self._client.get(self._key(tenant_id, turn_id))
        except Exception as exc:  # noqa: BLE001
            logger.warning("attribution_recall_redis_unreachable", extra={"error": str(exc)})
            return []
        if not raw:
            return []
        try:
            return [int(x) for x in json.loads(raw)]
        except Exception:  # noqa: BLE001
            return []

    @staticmethod
    def _key(tenant_id: str, turn_id: str) -> str:
        return f"{_KEY_PREFIX}{tenant_id}|{turn_id}"


_backend: _Backend | None = None


def _get_backend() -> _Backend:
    global _backend
    if _backend is not None:
        return _backend
    from app.config import get_settings

    settings = get_settings()
    if settings.environment.lower() in {"prod", "production"}:
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
            "attribution_redis_unavailable_falling_back_to_memory",
            extra={"error": str(exc)},
        )
        return _MemoryBackend()


def remember_turn_chunks(*, tenant_id: str, turn_id: str, chunk_ids: list[int]) -> None:
    """Record which chunks the retriever returned for this turn. Called from
    the orchestrator after retrieval; safe to call with an empty list."""
    if not tenant_id or not turn_id or not chunk_ids:
        return
    from app.config import get_settings

    ttl = int(get_settings().chunk_attribution_ttl_seconds)
    _get_backend().remember(tenant_id, turn_id, [int(c) for c in chunk_ids], ttl)


def recall_turn_chunks(*, tenant_id: str, turn_id: str) -> list[int]:
    if not tenant_id or not turn_id:
        return []
    return _get_backend().recall(tenant_id, turn_id)


def reset_for_tests() -> None:
    global _backend
    _backend = None
