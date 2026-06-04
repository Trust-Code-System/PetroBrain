"""
Admin feedback review API.

GET /admin/feedback?rating=&limit=&offset=&tenant_id=
GET /admin/feedback/summary

Role-gated to admin / platform_admin. Tenant-scoped via RLS + in-app filter
(same pattern as routes_admin_audit). Platform admins can pass ``?tenant_id=X``
to read another tenant's feedback for cross-tenant triage.

This is the read side of the feedback loop. Tenant admins watch the
thumbs-down stream so they know which answers needed correction; a future
slice will let them turn frequent corrections into per-tenant prompt memory.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import Principal, is_platform_admin, require_role
from app.db.feedback_repository import VALID_RATINGS, get_feedback_repository


router = APIRouter(prefix="/admin/feedback", tags=["admin", "feedback"])
_admin_or_platform = require_role("admin", "platform_admin")

MAX_LIMIT = 200
DEFAULT_LIMIT = 50


@router.get("")
async def list_feedback(
    tenant_id: str | None = Query(default=None),
    rating: str | None = Query(default=None),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    who: Principal = Depends(_admin_or_platform),
):
    if rating is not None and rating not in VALID_RATINGS:
        raise HTTPException(
            status_code=422,
            detail=f"rating must be one of {sorted(VALID_RATINGS)}",
        )
    effective_tenant = _resolve_target_tenant(who, tenant_id)
    rows = get_feedback_repository().list_records(
        tenant_id=effective_tenant, rating=rating, limit=limit, offset=offset,
    )
    return {"feedback": rows, "tenant_id": effective_tenant, "limit": limit, "offset": offset}


@router.get("/summary")
async def feedback_summary(
    tenant_id: str | None = Query(default=None),
    who: Principal = Depends(_admin_or_platform),
):
    """Counts for a quick dashboard: up vs. down + total, so an admin can see
    feedback velocity at a glance."""
    effective_tenant = _resolve_target_tenant(who, tenant_id)
    repo = get_feedback_repository()
    up = repo.count(tenant_id=effective_tenant, rating="up")
    down = repo.count(tenant_id=effective_tenant, rating="down")
    return {
        "tenant_id": effective_tenant,
        "up": up,
        "down": down,
        "total": up + down,
    }


def _resolve_target_tenant(who: Principal, tenant_id: str | None) -> str:
    if tenant_id is None:
        return who.tenant_id
    if not is_platform_admin(who) and tenant_id != who.tenant_id:
        raise HTTPException(status_code=403, detail="cross-tenant access denied")
    return tenant_id
