"""
Server-side automatic error capture.

Every qualifying failure an authenticated user hits is recorded into the
per-tenant error feed (``app/db/error_events_repository.py``, surfaced on the
``/admin`` page via ``GET /admin/errors``) WITHOUT the frontend having to report
it. The admin sees, for each error:

* the user-safe **message** the user actually saw (the "reason"), and
* a server-side **error_detail** in ``metadata`` - the exception type + message
  or the response detail (the "error") - which the raw provider/stack text the
  user is shielded from is safe to show an admin.

Capture scope (per operator decision): all ``5xx`` and unhandled exceptions, plus
genuine ``4xx`` failures; the routine, high-noise statuses ``401`` (auth
challenge), ``404`` (not found) and ``422`` (form validation) are skipped.

Two hard contracts, mirroring the audit sink:
1. Capture is **best-effort** and never raises into the request path - a failure
   here must not turn an error response into a different error.
2. Errors are attributed to the **authenticated** principal only. An anonymous
   request has no tenant to file under (and a tenant admin could not see it
   anyway under RLS), so it is skipped.
"""
from __future__ import annotations

import logging
import time
from threading import Lock
from typing import TYPE_CHECKING, Any

from app.config import get_settings
from app.db.error_events_repository import get_error_events_repository

if TYPE_CHECKING:
    from fastapi import Request

    from app.api.deps import Principal

logger = logging.getLogger(__name__)

# Routine, high-volume statuses that would bury real failures in the feed.
_SKIP_4XX = frozenset({401, 404, 422})

# Generic, user-safe fallback messages. Used when we can't (or shouldn't) read a
# detail off the response body - e.g. a streamed response or an unhandled 500
# whose raw text must never be shown to the user.
_GENERIC_MESSAGE: dict[int, str] = {
    400: "The request was invalid.",
    403: "You do not have permission to perform this action.",
    405: "That action is not allowed here.",
    409: "The request conflicts with the current state. Please refresh and retry.",
    413: "The upload is too large.",
    415: "That file type is not supported.",
    429: "Too many requests. Please slow down and try again shortly.",
    500: "Something went wrong on our end. Please try again.",
    502: "An upstream service returned an error. Please try again.",
    503: "The service is temporarily unavailable. Please try again shortly.",
    504: "The request timed out. Please try again.",
}

_MAX_DETAIL_CHARS = 2000

# In-process dedupe: collapse a storm of identical errors to one row per window.
_recent: dict[tuple[str, str, int, str], float] = {}
_recent_lock = Lock()


def should_capture(status: int, *, had_exception: bool = False) -> bool:
    """True if a response with ``status`` (or an unhandled exception) should be
    recorded. 5xx and exceptions always; 4xx except the routine skip-set."""
    if had_exception or status >= 500:
        return True
    if 400 <= status < 500:
        return status not in _SKIP_4XX
    return False


def user_message(status: int, detail: str | None) -> str:
    """The user-safe message to store. Prefer a detail parsed off the response
    (it is what the user saw) for 4xx; for 5xx always use the generic message so
    a raw internal error never lands in the user-visible ``message`` field."""
    if status < 500 and detail:
        return detail[:4000]
    return _GENERIC_MESSAGE.get(status, f"Request failed (HTTP {status}).")


def _dedupe_ok(key: tuple[str, str, int, str], *, window: int) -> bool:
    """Return True if this key has not been seen within ``window`` seconds (and
    record it). Prunes expired entries opportunistically so the map stays small."""
    now = time.monotonic()
    with _recent_lock:
        if _recent:
            cutoff = now - window
            for k, ts in list(_recent.items()):
                if ts < cutoff:
                    del _recent[k]
        last = _recent.get(key)
        if last is not None and now - last < window:
            return False
        _recent[key] = now
        return True


async def _resolve_principal(request: Request) -> Principal | None:
    """Best-effort: return the verified principal for the request, or None if the
    request is unauthenticated / the token is invalid. Reuses the real
    verification (signature, expiry, revocation, Neon) so a forged tenant_id can
    never write into another tenant's feed."""
    from app.api.deps import get_principal

    auth = request.headers.get("authorization", "")
    if not auth:
        return None
    try:
        return await get_principal(authorization=auth)
    except Exception:  # noqa: BLE001 - any auth failure => no attribution, skip
        return None


async def capture_error(
    request: Request,
    *,
    status: int,
    detail: str | None,
    exception_type: str = "",
) -> None:
    """Record one user-visible error into the per-tenant feed. Never raises."""
    try:
        settings = get_settings()
        if not settings.error_capture_enabled:
            return
        principal = await _resolve_principal(request)
        if principal is None:
            return  # anonymous: nothing to attribute / nobody could read it

        route = request.url.path
        clean_detail = (detail or "").strip()[:_MAX_DETAIL_CHARS]
        key = (principal.tenant_id, route, status, clean_detail)
        if not _dedupe_ok(key, window=settings.error_capture_dedupe_seconds):
            return

        metadata: dict[str, Any] = {
            "source": "server",
            "method": request.method,
        }
        if clean_detail:
            metadata["error_detail"] = clean_detail
        if exception_type:
            metadata["exception_type"] = exception_type

        repo = get_error_events_repository()
        repo.append(
            tenant_id=principal.tenant_id,
            user_id=principal.user_id,
            role=principal.role,
            route=route,
            status=status,
            message=user_message(status, detail),
            metadata=metadata,
        )
    except Exception as exc:  # noqa: BLE001 - capture must never break the request
        logger.warning("error_capture_failed error_type=%s error=%s", type(exc).__name__, exc)


async def error_capture_middleware(request: Request, call_next):
    """Outermost middleware: see the final response or the raised exception, and
    file a row when it qualifies. Sits OUTSIDE the app so it observes everything,
    but never alters the response it returns."""
    try:
        response = await call_next(request)
    except Exception as exc:  # noqa: BLE001 - record then re-raise unchanged
        await capture_error(
            request,
            status=500,
            detail=f"{type(exc).__name__}: {exc}",
            exception_type=type(exc).__name__,
        )
        raise
    if should_capture(response.status_code):
        # BaseHTTPMiddleware hands us a streaming response with no readable body,
        # so the HTTPException detail is stashed on request.state by
        # stash_http_detail (registered in app/main.py). Returned-without-raising
        # error responses have no stash -> a generic message is used.
        await capture_error(
            request,
            status=response.status_code,
            detail=getattr(request.state, "error_detail", None),
        )
    return response


async def stash_http_detail(request: Request, exc: Any):
    """HTTPException handler: stash the detail on request.state so the capture
    middleware can record it, then return the framework's normal response so
    behaviour is unchanged."""
    from fastapi.exception_handlers import http_exception_handler

    try:
        detail = getattr(exc, "detail", None)
        if detail is not None:
            request.state.error_detail = detail if isinstance(detail, str) else str(detail)
    except Exception:  # noqa: BLE001 - stashing must never break error handling
        pass
    return await http_exception_handler(request, exc)


def reset_dedupe_cache() -> None:
    """Clear the dedupe map (tests)."""
    with _recent_lock:
        _recent.clear()
