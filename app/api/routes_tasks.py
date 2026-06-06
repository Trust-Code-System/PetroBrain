"""Oil-and-gas compliance task and reminder API."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.api.deps import Principal, get_principal, require_role
from app.core.audit_hash import sha256_canonical
from app.core.task_service import advance_next_run
from app.db.audit_events_repository import get_audit_events_repository
from app.db.digests_repository import get_digests_repository
from app.db.notifications_repository import get_notifications_repository
from app.db.tasks_repository import get_tasks_repository
from app.db.users_repository import get_users_repository
from app.models.schemas import TaskCreate, TaskUpdate


router = APIRouter(prefix="/tasks", tags=["tasks"])
admin_router = APIRouter(prefix="/admin/tasks", tags=["admin", "tasks"])
_admin = require_role("admin", "platform_admin")


@router.post("", status_code=201)
async def create_task(req: TaskCreate, who: Principal = Depends(get_principal)):
    record = _create(req.model_dump(), who)
    return record


@router.get("")
async def list_tasks(
    status: str | None = None,
    category: str | None = None,
    assigned_to_me: bool = False,
    team: str | None = None,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    who: Principal = Depends(get_principal),
):
    rows = _repo().list(
        tenant_id=who.tenant_id,
        status=status,
        category=category,
        assigned_user_id=who.user_id if assigned_to_me else None,
        assigned_team=team,
        limit=limit,
        offset=offset,
    )
    return {"tasks": rows, "count": len(rows), "tenant_id": who.tenant_id}


@router.get("/due")
async def due_tasks(who: Principal = Depends(get_principal)):
    rows = _repo().list(tenant_id=who.tenant_id, due_only=True)
    return {"tasks": rows, "count": len(rows)}


@router.get("/digests")
async def scheduled_digests(who: Principal = Depends(get_principal)):
    rows = _digests().list(tenant_id=who.tenant_id)
    return {"digests": rows, "count": len(rows)}


@router.get("/{task_id}")
async def get_task(task_id: str, who: Principal = Depends(get_principal)):
    return _require_task(who.tenant_id, task_id)


@router.patch("/{task_id}")
async def update_task(
    task_id: str, req: TaskUpdate, who: Principal = Depends(get_principal),
):
    current = _require_task(who.tenant_id, task_id)
    patch = req.model_dump(exclude_unset=True)
    updated = _repo().update(tenant_id=who.tenant_id, task_id=task_id, patch=patch)
    _audit_task("task_updated", who, updated or current, {"patch": patch})
    return updated


@router.delete("/{task_id}", status_code=204)
async def delete_task(task_id: str, who: Principal = Depends(get_principal)):
    current = _require_task(who.tenant_id, task_id)
    if not _repo().delete(tenant_id=who.tenant_id, task_id=task_id):
        raise HTTPException(status_code=404, detail="task not found")
    _audit_task("task_updated", who, current, {"deleted": True})
    return Response(status_code=204)


@router.post("/{task_id}/complete")
async def complete_task(task_id: str, who: Principal = Depends(get_principal)):
    current = _require_task(who.tenant_id, task_id)
    now = datetime.now(timezone.utc).isoformat()
    next_run = advance_next_run(current)
    status = "active" if next_run else "completed"
    updated = _repo().update(
        tenant_id=who.tenant_id,
        task_id=task_id,
        patch={"status": status, "last_run_at": now, "next_run_at": next_run},
    )
    _audit_task("task_completed", who, updated or current, {"next_run_at": next_run})
    return updated


@router.post("/{task_id}/pause")
async def pause_task(task_id: str, who: Principal = Depends(get_principal)):
    return _set_status(task_id, "paused", who)


@router.post("/{task_id}/resume")
async def resume_task(task_id: str, who: Principal = Depends(get_principal)):
    return _set_status(task_id, "active", who)


@admin_router.get("")
async def admin_tasks(who: Principal = Depends(_admin)):
    rows = _repo().list(tenant_id=who.tenant_id, limit=500)
    return {"tasks": rows, "count": len(rows), "tenant_id": who.tenant_id}


@admin_router.get("/overdue")
async def admin_overdue_tasks(who: Principal = Depends(_admin)):
    rows = _repo().list(tenant_id=who.tenant_id, overdue_only=True, limit=500)
    return {"tasks": rows, "count": len(rows), "tenant_id": who.tenant_id}


def _create(data: dict, who: Principal) -> dict:
    user = get_users_repository().get(tenant_id=who.tenant_id, user_id=who.user_id)
    create_data = {
        **data,
        "tenant_id": who.tenant_id,
        "created_by_user_id": who.user_id,
        "created_by_user_name": (user or {}).get("email"),
    }
    create_data.setdefault("next_run_at", data.get("start_date") or data.get("due_date"))
    record = _repo().create(
        **create_data,
    ).as_dict()
    digest_config = record.get("digest_config")
    if digest_config:
        digest = _digests().create(
            tenant_id=who.tenant_id,
            created_by_user_id=who.user_id,
            title=record["title"],
            topics=digest_config.get("topics"),
            sources_allowed=digest_config.get("sources_allowed"),
            domains_allowed=digest_config.get("domains_allowed"),
            recurrence_rule=record.get("recurrence_rule"),
            next_run_at=record.get("next_run_at"),
            output_format=digest_config.get("output_format"),
            recipients=record.get("assigned_to_user_ids"),
            task_id=record["task_id"],
        )
        record["digest_config"] = {**digest_config, "digest_id": digest["digest_id"]}
        _repo().update(
            tenant_id=who.tenant_id,
            task_id=record["task_id"],
            patch={"digest_config": record["digest_config"]},
        )
    audit = _audit_task("task_created", who, record, {"task": record})
    if digest_config:
        _audit_task(
            "scheduled_digest_created",
            who,
            record,
            {"digest_id": record["digest_config"]["digest_id"]},
        )
    _notifications().create(
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        user_name=(user or {}).get("email"),
        user_role=who.role,
        title="Compliance task created",
        message=record["title"],
        category="task",
        severity="medium" if record["compliance_critical"] else "info",
        related_audit_id=str(audit.id),
        related_task_id=record["task_id"],
        related_module=record.get("related_module"),
        metadata={"status": record["status"], "next_run_at": record.get("next_run_at")},
    )
    return record


def create_task_for_chat(data: dict, who: Principal) -> dict:
    return _create(data, who)


def _set_status(task_id: str, status: str, who: Principal):
    current = _require_task(who.tenant_id, task_id)
    updated = _repo().update(
        tenant_id=who.tenant_id, task_id=task_id, patch={"status": status}
    )
    _audit_task("task_updated", who, updated or current, {"status": status})
    return updated


def _require_task(tenant_id: str, task_id: str) -> dict:
    record = _repo().get(tenant_id=tenant_id, task_id=task_id)
    if record is None:
        raise HTTPException(status_code=404, detail="task not found")
    return record


def _audit_task(action: str, who: Principal, task: dict, metadata: dict):
    return get_audit_events_repository().append(
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        action=action,
        module=task.get("related_module") or "tasks",
        request_hash=sha256_canonical(metadata),
        response_hash=sha256_canonical(task),
        flags=["compliance_critical"] if task.get("compliance_critical") else [],
        usage={
            "risk_level": "high" if task.get("compliance_critical") else "low",
            "status": "success",
            "task_id": task["task_id"],
            "action_summary": task["title"],
            "metadata": metadata,
        },
    )


def _repo():
    return get_tasks_repository()


def _notifications():
    return get_notifications_repository()


def _digests():
    return get_digests_repository()
