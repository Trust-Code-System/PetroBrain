"""
User management (B8).

Lives under ``/admin/tenants/{tenant_id}/users`` so cross-tenant routing
is explicit. Authorisation:

  * platform_admin     - any tenant (any flow)
  * tenant admin       - only their own tenant
  * everyone else      - 403

Status flows:
  invited → active     (POST .../{user_id}/activate)
  any     → deactivated (POST .../{user_id}/deactivate)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import (
    Principal,
    get_principal,
    require_tenant_access,
)
from app.core.audit import AuditEvent, get_audit_logger
from app.db.users_repository import get_users_repository
from app.models.schemas import (
    UserInvite,
    UserSetAllowedAssets,
    UserSetRole,
    UserSetStatus,
)


router = APIRouter(prefix="/admin/tenants/{tenant_id}/users", tags=["admin", "users"])
audit_logger = get_audit_logger()


def _require_tenant_admin(principal: Principal, tenant_id: str) -> None:
    """Allow platform_admin (any tenant) or tenant admin (only own tenant)."""
    if principal.role == "platform_admin":
        return
    if principal.role == "admin":
        require_tenant_access(principal, tenant_id)
        return
    raise HTTPException(status_code=403, detail="role not allowed for principal")


@router.get("")
async def list_users(
    tenant_id: str,
    status: str | None = None,
    role: str | None = None,
    who: Principal = Depends(get_principal),
):
    _require_tenant_admin(who, tenant_id)
    rows = _repository().list_records(tenant_id=tenant_id, status=status, role=role)
    return {"users": rows}


@router.post("", status_code=201)
async def invite_user(
    tenant_id: str,
    req: UserInvite,
    who: Principal = Depends(get_principal),
):
    _require_tenant_admin(who, tenant_id)
    try:
        record = _repository().invite(
            tenant_id=tenant_id,
            email=req.email,
            role=req.role,
            allowed_assets=req.allowed_assets,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _audit(who, "user_invite", tenant_id, record.as_dict(), {"role": req.role})
    return record.as_dict()


@router.patch("/{user_id}/role")
async def set_role(
    tenant_id: str,
    user_id: str,
    req: UserSetRole,
    who: Principal = Depends(get_principal),
):
    _require_tenant_admin(who, tenant_id)
    try:
        record = _repository().set_role(
            tenant_id=tenant_id, user_id=user_id, role=req.role,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _audit(who, "user_set_role", tenant_id, record, {"user_id": user_id, "role": req.role})
    return record


@router.patch("/{user_id}/status")
async def set_status(
    tenant_id: str,
    user_id: str,
    req: UserSetStatus,
    who: Principal = Depends(get_principal),
):
    _require_tenant_admin(who, tenant_id)
    try:
        record = _repository().set_status(
            tenant_id=tenant_id, user_id=user_id, status=req.status,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _audit(
        who,
        "user_set_status",
        tenant_id,
        record,
        {"user_id": user_id, "status": req.status},
    )
    return record


@router.patch("/{user_id}/allowed-assets")
async def set_allowed_assets(
    tenant_id: str,
    user_id: str,
    req: UserSetAllowedAssets,
    who: Principal = Depends(get_principal),
):
    _require_tenant_admin(who, tenant_id)
    try:
        record = _repository().set_allowed_assets(
            tenant_id=tenant_id, user_id=user_id,
            allowed_assets=req.allowed_assets,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _audit(
        who,
        "user_set_allowed_assets",
        tenant_id,
        record,
        {"user_id": user_id, "allowed_assets": req.allowed_assets},
    )
    return record


def _repository():
    return get_users_repository()


def _audit(who: Principal, event_type: str, tenant_id: str,
           record: dict, metadata: dict) -> None:
    audit_logger.write(AuditEvent(
        event_type=event_type,
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/admin/tenants/{tenant_id}/users",
        request={"target_tenant_id": tenant_id, **metadata},
        response=record,
        metadata={"target_tenant_id": tenant_id, **metadata},
    ))
