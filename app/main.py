"""FastAPI entrypoint - the Phase-1 Tier-A spine."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import (
    routes_account,
    routes_admin_audit,
    routes_admin_chunk_weights,
    routes_admin_data_readiness,
    routes_admin_documents,
    routes_admin_feedback,
    routes_admin_memory,
    routes_admin_notifications,
    routes_admin_permits,
    routes_admin_tenants,
    routes_admin_users,
    routes_assets,
    routes_auth,
    routes_calc,
    routes_chat,
    routes_chat_shares,
    routes_documents,
    routes_emissions,
    routes_errors,
    routes_research,
    routes_onboarding,
    routes_tasks,
    routes_wellcontrol,
)
from app.config import (
    get_settings,
    validate_production_settings,
    warn_on_degraded_embeddings,
)
from app.core.error_capture import error_capture_middleware, stash_http_detail
from app.core.http_hardening import (
    add_security_headers,
    check_rate_limit,
    rate_limit_key,
    verify_metrics_access,
)
from app.core.observability import metrics_response, setup_observability

settings = get_settings()
validate_production_settings(settings)
# Non-fatal: log a clear warning at boot if embeddings can't work as configured
# (missing key / no self-hosted endpoint), so the operator sees it before users
# hit failed ingestion. Runtime exhaustion (out of quota) is alarmed separately.
warn_on_degraded_embeddings(settings)

# H9: refuse to boot in prod if the DB role bypasses RLS. No-op outside prod
# or when persistence is local_json. Catches the common ops shortcut of
# pointing the app at the RDS master/superuser by mistake.
try:
    from app.db import pg as _pg

    _pg.assert_role_safe_for_rls()
except RuntimeError:
    raise
except Exception:  # noqa: BLE001 - dependency missing / DB unreachable at import time
    # In prod the validator + the DB pool will fail fast on the next call;
    # we don't want to make a transient connect blip block startup.
    pass

app = FastAPI(title=settings.app_name, version="0.1.0")
STATIC_DIR = Path(__file__).resolve().parent / "static"

# Allow the browser-based web/admin apps (served from a different port) to call
# this API. Added BEFORE observability instrumentation, which builds/wraps the
# middleware stack - middleware added after instrument_app is ignored. Auth is
# via the Authorization header (no cookies), so credentials stay off; lock the
# origin allowlist down in production via PB_CORS_ALLOW_ORIGINS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_allow_origins.split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)

setup_observability(app, settings)


@app.middleware("http")
async def hardening_middleware(request: Request, call_next):
    limit = rate_limit_key(request, settings)
    if limit is not None:
        try:
            check_rate_limit(*limit)
        except HTTPException as exc:
            return add_security_headers(
                JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
            )
    response = await call_next(request)
    return add_security_headers(response)


# Registered AFTER hardening so it wraps it (outermost user middleware): it
# observes the final status / any unhandled exception and files a row into the
# per-tenant error feed so the admin sees every failure a user hits. Best-effort;
# never alters the response. See app/core/error_capture.py.
app.middleware("http")(error_capture_middleware)

# Stash HTTPException detail on request.state so the capture middleware can
# record the reason the user saw (the streaming response it gets has no body).
# Delegates to the framework default, so error responses are unchanged.
app.add_exception_handler(StarletteHTTPException, stash_http_detail)

app.include_router(routes_auth.router)
app.include_router(routes_chat.router)
app.include_router(routes_chat_shares.router)
app.include_router(routes_wellcontrol.router)
app.include_router(routes_emissions.router)
app.include_router(routes_documents.router)
app.include_router(routes_documents.docs_router)
app.include_router(routes_admin_documents.router)
app.include_router(routes_admin_audit.router)
app.include_router(routes_admin_notifications.router)
app.include_router(routes_assets.router)
app.include_router(routes_calc.router)
app.include_router(routes_admin_tenants.router)
app.include_router(routes_admin_users.router)
app.include_router(routes_admin_data_readiness.router)
app.include_router(routes_admin_permits.router)
app.include_router(routes_admin_feedback.router)
app.include_router(routes_admin_memory.router)
app.include_router(routes_admin_chunk_weights.router)
app.include_router(routes_errors.report_router)
app.include_router(routes_errors.admin_router)
app.include_router(routes_research.router)
app.include_router(routes_onboarding.onboarding_router)
app.include_router(routes_onboarding.organizations_router)
app.include_router(routes_onboarding.invitations_router)
app.include_router(routes_onboarding.company_admin_router)
app.include_router(routes_tasks.router)
app.include_router(routes_tasks.admin_router)
app.include_router(routes_account.router)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health():
    env = (settings.environment or "").lower()
    demo = env == "demo" or settings.object_store_backend == "memory"
    allowed_origins = [
        o.strip() for o in settings.cors_allow_origins.split(",") if o.strip()
    ]
    return {
        "status": "ok",
        "app": settings.app_name,
        "tier": "B" if settings.operational_tier else "A",
        "environment": settings.environment,
        # Truthy when state is ephemeral (Render free tier / in-memory object
        # store). Clients SHOULD surface a banner so users don't treat the
        # instance as production.
        "demo": demo,
        "warning": (
            "This is a DEMO instance. Uploads and state are not persisted "
            "across restarts. Do not use for production data."
            if demo else None
        ),
        # Surfaced so ops can spot a misconfigured CORS allowlist without
        # tailing config: a wildcarded or unexpected entry shows up here
        # immediately. Public information (browsers know it anyway).
        "allowed_origins": allowed_origins,
    }


@app.get("/metrics", include_in_schema=False)
async def metrics(request: Request):
    verify_metrics_access(request, settings)
    return metrics_response()
