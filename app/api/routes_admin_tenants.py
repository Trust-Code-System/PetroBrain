"""
Tenant management (B8).

GET    /admin/tenants                   - platform_admin only, list all
GET    /admin/tenants/{tenant_id}       - platform_admin OR tenant admin reading own row
POST   /admin/tenants                   - platform_admin only
PATCH  /admin/tenants/{tenant_id}       - platform_admin only (rename, suspend, ...)

A suspension here is the cleanest kill-switch we have today: subsequent
JWTs minted for that tenant still authenticate (signature still valid),
but downstream surfaces are expected to check ``tenant.status`` before
serving sensitive data. We surface the status verbatim so callers can
decide.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import (
    Principal,
    get_principal,
    require_role,
    require_tenant_access,
)
from app.core.audit import AuditEvent, get_audit_logger
from app.db.tenants_repository import get_tenants_repository
from app.models.schemas import TenantCreate, TenantUpdate


router = APIRouter(prefix="/admin/tenants", tags=["admin", "tenants"])
audit_logger = get_audit_logger()

_platform = require_role("platform_admin")


@router.get("")
async def list_tenants(
    status: str | None = None,
    who: Principal = Depends(_platform),
):
    rows = _repository().list_records(status=status)
    return {"tenants": rows}


@router.post("", status_code=201)
async def create_tenant(req: TenantCreate, who: Principal = Depends(_platform)):
    try:
        record = _repository().create(
            id=req.id, name=req.name, attributes=req.attributes,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    audit_logger.write(AuditEvent(
        event_type="tenant_create",
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/admin/tenants",
        request=req.model_dump(),
        response=record.as_dict(),
        metadata={"tenant_id": record.id},
    ))
    return record.as_dict()


@router.get("/{tenant_id}")
async def get_tenant(tenant_id: str, who: Principal = Depends(get_principal)):
    require_tenant_access(who, tenant_id)
    record = _repository().get(tenant_id)
    if record is None:
        raise HTTPException(status_code=404, detail="tenant not found")
    return record


@router.patch("/{tenant_id}")
async def update_tenant(
    tenant_id: str,
    req: TenantUpdate,
    who: Principal = Depends(_platform),
):
    try:
        record = _repository().update(
            tenant_id,
            name=req.name,
            status=req.status,
            attributes=req.attributes,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    audit_logger.write(AuditEvent(
        event_type="tenant_update",
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/admin/tenants",
        request={**req.model_dump(), "tenant_id": tenant_id},
        response=record,
        metadata={"tenant_id": tenant_id},
    ))
    return record


def _repository():
    return get_tenants_repository()
