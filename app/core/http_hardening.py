"""HTTP hardening middleware: security headers, metrics auth and rate limits.

The rate limiter has two backends:

* ``MemoryBackend``  - per-process ``defaultdict[str, deque]``. Used in dev and
  tests; not safe across uvicorn workers or ECS tasks. Picked automatically when
  PB_ENVIRONMENT is not prod.
* ``RedisBackend``   - atomic ``INCR`` + ``EXPIRE`` against the configured Redis.
  One bucket per (key, window), shared across replicas. Picked automatically in
  prod; overridable via PB_RATE_LIMIT_BACKEND.

Client identification is JWT-principal-first, falling back to the *trusted*
client IP only for unauthenticated requests. ``X-Forwarded-For`` is honoured
only when the immediate peer is inside ``PB_TRUSTED_PROXY_CIDRS`` - otherwise we
treat ``request.client.host`` as authoritative so a remote attacker can't spoof
their way to a new rate-limit bucket per request.
"""
from __future__ import annotations

import ipaddress
import logging
import time
from collections import defaultdict, deque
from typing import Protocol

import jwt
from fastapi import HTTPException, Request
from starlette.responses import Response

from app.config import Settings

logger = logging.getLogger(__name__)

_WINDOW_SECONDS = 60


def add_security_headers(response: Response) -> Response:
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    # H1 also defends against this surface (jti revocation + 1h TTL), but the
    # primary win here is closing the XSS exfiltration path that defeats H1.
    # script-src now drops 'unsafe-inline'; Next.js apps emit standard bundled
    # scripts with their own integrity. style-src keeps 'unsafe-inline'
    # because Tailwind components emit small inline style blocks; nonce-based
    # styling is a larger frontend rewrite scheduled as a Phase-2 follow-up.
    # connect-src http://localhost is dev-only and is removed in prod (L1).
    from app.config import get_settings
    s = get_settings()
    is_dev = s.environment.lower() not in {"prod", "production"}
    connect_src = "connect-src 'self'"
    if is_dev:
        connect_src += " http://localhost:* http://127.0.0.1:*"
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob:; "
        f"{connect_src}; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    )
    # Tier A/B prod also enables HSTS so a downgrade isn't accepted by the
    # browser even on the first hit after the rollout.
    if not is_dev:
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=31536000; includeSubDomains; preload",
        )
    return response


def rate_limit_key(request: Request, settings: Settings) -> tuple[str, int] | None:
    path = request.url.path
    method = request.method.upper()
    if path in {"/auth/signup", "/auth/signin", "/auth/refresh"} and method == "POST":
        # Auth routes are always IP-keyed: a credential-stuffing attacker isn't
        # carrying a valid JWT, so principal-based keying would do nothing.
        return (
            f"auth:{_trusted_client_ip(request, settings)}:{path}",
            _setting(settings, "auth_rate_limit_per_minute", 20),
        )
    if path == "/admin/documents" and method == "POST":
        return (
            f"upload:{_principal_or_ip(request, settings)}",
            _setting(settings, "upload_rate_limit_per_minute", 10),
        )
    if path == "/chat" and method == "POST":
        return (
            f"chat:{_principal_or_ip(request, settings)}",
            _setting(settings, "api_rate_limit_per_minute", 120),
        )
    return None


def check_rate_limit(key: str, limit: int) -> None:
    if limit <= 0:
        return
    backend = _get_backend()
    if backend.over_limit(key, limit, _WINDOW_SECONDS):
        raise HTTPException(status_code=429, detail="rate limit exceeded")


def verify_metrics_access(request: Request, settings: Settings) -> None:
    if settings.environment.lower() not in {"prod", "production"}:
        return
    expected = settings.metrics_auth_token.strip()
    if not expected:
        raise HTTPException(status_code=404, detail="not found")
    supplied = request.headers.get("x-metrics-token", "")
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        supplied = auth.partition(" ")[2]
    if supplied != expected:
        raise HTTPException(status_code=404, detail="not found")


def clear_rate_limits() -> None:
    """Reset the backing store. Tests call this between cases."""
    global _backend_singleton
    _backend_singleton = None


# --- backend abstraction ------------------------------------------------------

class _Backend(Protocol):
    def over_limit(self, key: str, limit: int, window_seconds: int) -> bool: ...


class _MemoryBackend:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def over_limit(self, key: str, limit: int, window_seconds: int) -> bool:
        now = time.monotonic()
        bucket = self._hits[key]
        while bucket and now - bucket[0] >= window_seconds:
            bucket.popleft()
        if len(bucket) >= limit:
            return True
        bucket.append(now)
        return False


class _RedisBackend:
    """Atomic fixed-window counter: INCR key; EXPIRE on first hit. Same bucket
    across uvicorn workers and ECS tasks. Falls open (logs + permits) if Redis
    is temporarily unreachable so a Redis incident doesn't take auth down."""

    def __init__(self, client) -> None:  # type: ignore[no-untyped-def]
        self._client = client

    def over_limit(self, key: str, limit: int, window_seconds: int) -> bool:
        bucket = f"pb:rl:{key}:{int(time.time()) // window_seconds}"
        try:
            pipe = self._client.pipeline()
            pipe.incr(bucket, 1)
            pipe.expire(bucket, window_seconds)
            count, _ = pipe.execute()
        except Exception as exc:  # noqa: BLE001
            logger.warning("rate_limit_backend_unreachable", extra={"error": str(exc)})
            return False
        return int(count) > limit


_backend_singleton: _Backend | None = None


def _get_backend() -> _Backend:
    global _backend_singleton
    if _backend_singleton is not None:
        return _backend_singleton
    from app.config import get_settings

    settings = get_settings()
    choice = (settings.rate_limit_backend or "").strip().lower()
    if not choice:
        choice = "redis" if settings.environment.lower() in {"prod", "production"} else "memory"
    if choice == "redis":
        _backend_singleton = _build_redis_backend(settings)
    else:
        _backend_singleton = _MemoryBackend()
    return _backend_singleton


def _build_redis_backend(settings: Settings) -> _Backend:
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
            "rate_limit_redis_unavailable_falling_back_to_memory",
            extra={"error": str(exc)},
        )
        return _MemoryBackend()


# --- client identification ----------------------------------------------------

def _trusted_client_ip(request: Request, settings: Settings) -> str:
    direct = request.client.host if request.client else ""
    nets = _trusted_cidrs(settings.trusted_proxy_cidrs)
    if not nets or not direct or not _ip_in_any(direct, nets):
        return direct or "unknown"
    forwarded = request.headers.get("x-forwarded-for", "")
    if not forwarded:
        return direct
    # Left-most non-trusted hop is the real client. Skip XFF entries that are
    # themselves trusted proxies so a chain (ALB -> sidecar -> app) resolves
    # to the actual peer rather than the inner load balancer.
    for raw in (h.strip() for h in forwarded.split(",")):
        if not raw:
            continue
        if not _ip_in_any(raw, nets):
            return raw
    return direct


def _principal_or_ip(request: Request, settings: Settings) -> str:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth.partition(" ")[2].strip()
        sub = _unverified_sub(token)
        if sub:
            return f"user:{sub}"
    return f"ip:{_trusted_client_ip(request, settings)}"


def _unverified_sub(token: str) -> str | None:
    """Read the JWT ``sub`` claim WITHOUT verifying the signature - safe here
    because get_principal() does the real verification before any business
    logic runs. The unverified value is only used to bucket rate-limit hits."""
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
    except Exception:  # noqa: BLE001
        return None
    sub = claims.get("user_id") or claims.get("sub")
    return str(sub) if isinstance(sub, str) and sub else None


def _trusted_cidrs(raw: str) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    nets: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for piece in (p.strip() for p in (raw or "").split(",") if p.strip()):
        try:
            nets.append(ipaddress.ip_network(piece, strict=False))
        except ValueError:
            logger.warning("invalid_trusted_proxy_cidr", extra={"value": piece})
    return nets


def _ip_in_any(addr: str, nets: list) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return any(ip in n for n in nets)


def _setting(settings: Settings, name: str, default: int) -> int:
    return int(getattr(settings, name, default))
