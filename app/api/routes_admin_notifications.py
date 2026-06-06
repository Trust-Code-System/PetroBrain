"""Tenant-scoped admin notification center API."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.api.deps import Principal, require_role
from app.db.notifications_repository import get_notifications_repository
from app.models.schemas import NotificationUpdate


router = APIRouter(prefix="/admin/notifications", tags=["admin", "notifications"])
_admin = require_role("admin", "platform_admin")


@router.get("")
async def list_notifications(
    status: str | None = None,
    severity: str | None = None,
    category: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    who: Principal = Depends(_admin),
):
    rows = _repo().list(
        tenant_id=who.tenant_id, status=status, severity=severity,
        category=category, limit=limit, offset=offset,
    )
    return {"notifications": rows, "count": len(rows), "tenant_id": who.tenant_id}


@router.get("/unread")
async def unread_notifications(who: Principal = Depends(_admin)):
    rows = _repo().list(tenant_id=who.tenant_id, status="unread", limit=500)
    return {"notifications": rows, "count": len(rows)}


@router.get("/{notification_id}")
async def get_notification(notification_id: str, who: Principal = Depends(_admin)):
    row = _repo().get(tenant_id=who.tenant_id, notification_id=notification_id)
    if row is None:
        raise HTTPException(status_code=404, detail="notification not found")
    return row


@router.post("/{notification_id}/acknowledge")
async def acknowledge_notification(
    notification_id: str, _req: NotificationUpdate | None = None,
    who: Principal = Depends(_admin),
):
    return _update(notification_id, "acknowledged", who)


@router.post("/{notification_id}/resolve")
async def resolve_notification(
    notification_id: str, _req: NotificationUpdate | None = None,
    who: Principal = Depends(_admin),
):
    return _update(notification_id, "resolved", who)


@router.delete("/{notification_id}", status_code=204)
async def delete_notification(notification_id: str, who: Principal = Depends(_admin)):
    if not _repo().delete(tenant_id=who.tenant_id, notification_id=notification_id):
        raise HTTPException(status_code=404, detail="notification not found")
    return Response(status_code=204)


def _update(notification_id: str, status: str, who: Principal):
    row = _repo().update_status(
        tenant_id=who.tenant_id,
        notification_id=notification_id,
        status=status,
        actor_id=who.user_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="notification not found")
    return row


def _repo():
    return get_notifications_repository()
