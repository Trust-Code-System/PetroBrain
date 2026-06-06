"""
Admin audit log read API (A6 + B8 cross-tenant override).

GET /admin/audit?tenant_id=&from=&to=&user_id=&module=&action=&limit=&offset=

Tenant-scoped (RLS in production Postgres; in-app filter in the Phase-1
JSONL backend). Role-gated to ``admin`` or ``platform_admin``. Returns
hash-only audit rows so no raw user text or model output ever leaves
the audit store.

B8: platform admins may pass ``?tenant_id=X`` to read another tenant's
events. Anyone else who passes a tenant_id that disagrees with their
principal gets a 403.
"""
from __future__ import annotations

from datetime import datetime, timezone

import csv
import io
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from app.api.deps import Principal, is_platform_admin, require_role
from app.db.audit_events_repository import get_audit_events_repository
from app.models.schemas import AuditExportRequest


router = APIRouter(prefix="/admin/audit", tags=["admin", "audit"])
_admin_or_platform = require_role("admin", "platform_admin")

MAX_LIMIT = 200
DEFAULT_LIMIT = 50


@router.get("")
async def list_audit_events(
    tenant_id: str | None = Query(default=None),
    from_: datetime | None = Query(default=None, alias="from"),
    to: datetime | None = Query(default=None),
    user_id: str | None = Query(default=None),
    module: str | None = Query(default=None),
    action: str | None = Query(default=None),
    risk_level: str | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    who: Principal = Depends(_admin_or_platform),
):
    if from_ is not None and to is not None and from_ > to:
        raise HTTPException(status_code=422, detail="`from` must be <= `to`")
    effective_tenant = _resolve_target_tenant(who, tenant_id)
    rows = _repository().query(
        tenant_id=effective_tenant,
        from_ts=_as_utc(from_),
        to_ts=_as_utc(to),
        user_id=user_id,
        module=module,
        action=action,
        risk_level=risk_level,
        status=status,
        limit=limit,
        offset=offset,
    )
    return {
        "tenant_id": effective_tenant,
        "events": rows,
        "count": len(rows),
        "limit": limit,
        "offset": offset,
    }


@router.get("/safety-events")
async def safety_events(who: Principal = Depends(_admin_or_platform)):
    rows = _repository().query(
        tenant_id=who.tenant_id, action="bypass_attempt", limit=200
    )
    return {"events": rows, "count": len(rows), "tenant_id": who.tenant_id}


@router.get("/bypass-attempts")
async def bypass_attempts(who: Principal = Depends(_admin_or_platform)):
    return await safety_events(who)


@router.get("/by-user/{user_id}")
async def audit_by_user(user_id: str, who: Principal = Depends(_admin_or_platform)):
    rows = _repository().query(tenant_id=who.tenant_id, user_id=user_id, limit=200)
    return {"events": rows, "count": len(rows), "tenant_id": who.tenant_id}


@router.get("/by-tenant/{tenant_id}")
async def audit_by_tenant(tenant_id: str, who: Principal = Depends(_admin_or_platform)):
    effective = _resolve_target_tenant(who, tenant_id)
    rows = _repository().query(tenant_id=effective, limit=200)
    return {"events": rows, "count": len(rows), "tenant_id": effective}


@router.get("/by-module/{module}")
async def audit_by_module(module: str, who: Principal = Depends(_admin_or_platform)):
    rows = _repository().query(tenant_id=who.tenant_id, module=module, limit=200)
    return {"events": rows, "count": len(rows), "tenant_id": who.tenant_id}


@router.get("/research/{research_id}")
async def audit_for_research(
    research_id: str, who: Principal = Depends(_admin_or_platform),
):
    rows = _repository().query(tenant_id=who.tenant_id, module="research", limit=500)
    matches = [
        row for row in rows
        if str((row.get("usage") or {}).get("research_id") or "") == research_id
    ]
    return {"events": matches, "count": len(matches), "tenant_id": who.tenant_id}


@router.get("/tasks/{task_id}")
async def audit_for_task(task_id: str, who: Principal = Depends(_admin_or_platform)):
    rows = _repository().query(tenant_id=who.tenant_id, limit=500)
    matches = [
        row for row in rows
        if str((row.get("usage") or {}).get("task_id") or "") == task_id
    ]
    return {"events": matches, "count": len(matches), "tenant_id": who.tenant_id}


@router.get("/{audit_id}")
async def audit_detail(audit_id: str, who: Principal = Depends(_admin_or_platform)):
    row = _repository().get(tenant_id=who.tenant_id, audit_id=audit_id)
    if row is None:
        raise HTTPException(status_code=404, detail="audit event not found")
    return row


@router.post("/export")
async def export_audit(
    req: AuditExportRequest, who: Principal = Depends(_admin_or_platform),
):
    tenant_id = _resolve_target_tenant(who, req.tenant_id)
    rows = _repository().query(
        tenant_id=tenant_id,
        from_ts=_as_utc(req.from_),
        to_ts=_as_utc(req.to),
        user_id=req.user_id,
        module=req.module,
        action=req.action,
        risk_level=req.risk_level,
        limit=500,
    )
    if req.format.lower() == "csv":
        buffer = io.StringIO()
        fields = ["id", "ts", "tenant_id", "user_id", "role", "action", "module", "request_hash", "response_hash", "flags", "usage"]
        writer = csv.DictWriter(buffer, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({
                **{key: row.get(key) for key in fields},
                "flags": json.dumps(row.get("flags") or []),
                "usage": json.dumps(row.get("usage") or {}),
            })
        return Response(buffer.getvalue(), media_type="text/csv")
    return {"tenant_id": tenant_id, "events": rows, "count": len(rows)}


def _resolve_target_tenant(principal: Principal, requested: str | None) -> str:
    if requested is None:
        return principal.tenant_id
    if requested != principal.tenant_id and not is_platform_admin(principal):
        raise HTTPException(status_code=403, detail="cross-tenant access denied")
    return requested


def _repository():
    return get_audit_events_repository()


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
