"""Tenant-scoped persistence for PetroBrain compliance and operations tasks."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from app.config import get_settings


TASK_STATUSES = {"pending", "active", "completed", "cancelled", "paused", "failed"}
TASK_PRIORITIES = {"low", "medium", "high", "critical"}
RECURRENCE_TYPES = {"none", "daily", "weekly", "monthly", "quarterly", "yearly", "custom"}


@dataclass
class TaskRecord:
    task_id: str
    tenant_id: str
    created_by_user_id: str
    created_by_user_name: str | None
    assigned_to_user_ids: list[str]
    assigned_to_team: str | None
    title: str
    description: str
    category: str
    priority: str
    status: str
    recurrence_type: str
    recurrence_rule: dict[str, Any]
    start_date: str | None
    due_date: str | None
    timezone: str
    next_run_at: str | None
    last_run_at: str | None
    reminder_channels: list[str]
    related_module: str | None
    related_asset_id: str | None
    related_project_id: str | None
    related_document_id: str | None
    safety_critical: bool
    compliance_critical: bool
    digest_config: dict[str, Any] | None
    created_at: str
    updated_at: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso(value: datetime | str | None) -> str | None:
    if value is None or isinstance(value, str):
        return value
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _validate(data: dict[str, Any]) -> None:
    if not data.get("tenant_id") or not data.get("created_by_user_id"):
        raise ValueError("tenant_id and created_by_user_id are required")
    if not str(data.get("title") or "").strip():
        raise ValueError("title is required")
    if data.get("status", "active") not in TASK_STATUSES:
        raise ValueError("invalid task status")
    if data.get("priority", "medium") not in TASK_PRIORITIES:
        raise ValueError("invalid task priority")
    if data.get("recurrence_type", "none") not in RECURRENCE_TYPES:
        raise ValueError("invalid recurrence_type")


class LocalJsonTasksRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def create(self, **data: Any) -> TaskRecord:
        _validate(data)
        now = _now()
        record = TaskRecord(
            task_id=str(uuid4()),
            tenant_id=data["tenant_id"],
            created_by_user_id=data["created_by_user_id"],
            created_by_user_name=data.get("created_by_user_name"),
            assigned_to_user_ids=list(data.get("assigned_to_user_ids") or []),
            assigned_to_team=data.get("assigned_to_team"),
            title=str(data["title"]).strip(),
            description=str(data.get("description") or "").strip(),
            category=str(data.get("category") or "compliance_calendar"),
            priority=data.get("priority") or "medium",
            status=data.get("status") or "active",
            recurrence_type=data.get("recurrence_type") or "none",
            recurrence_rule=dict(data.get("recurrence_rule") or {}),
            start_date=_iso(data.get("start_date")),
            due_date=_iso(data.get("due_date")),
            timezone=data.get("timezone") or "Africa/Lagos",
            next_run_at=_iso(data.get("next_run_at") or data.get("due_date")),
            last_run_at=_iso(data.get("last_run_at")),
            reminder_channels=list(data.get("reminder_channels") or ["in_app"]),
            related_module=data.get("related_module"),
            related_asset_id=data.get("related_asset_id"),
            related_project_id=data.get("related_project_id"),
            related_document_id=data.get("related_document_id"),
            safety_critical=bool(data.get("safety_critical")),
            compliance_critical=bool(data.get("compliance_critical")),
            digest_config=dict(data["digest_config"]) if data.get("digest_config") else None,
            created_at=now,
            updated_at=now,
        )
        with self._lock:
            rows = self._read_locked()
            rows.append(record.as_dict())
            self._write_locked(rows)
        return record

    def get(self, *, tenant_id: str, task_id: str) -> dict[str, Any] | None:
        return next(
            (r for r in self._read() if r["tenant_id"] == tenant_id and r["task_id"] == task_id),
            None,
        )

    def list(
        self, *, tenant_id: str, status: str | None = None,
        category: str | None = None, assigned_user_id: str | None = None,
        assigned_team: str | None = None, overdue_only: bool = False,
        due_only: bool = False, limit: int = 100, offset: int = 0,
    ) -> list[dict[str, Any]]:
        now = _now()
        rows = [r for r in self._read() if r["tenant_id"] == tenant_id]
        if status:
            rows = [r for r in rows if r.get("status") == status]
        if category:
            rows = [r for r in rows if r.get("category") == category]
        if assigned_user_id:
            rows = [r for r in rows if assigned_user_id in (r.get("assigned_to_user_ids") or [])]
        if assigned_team:
            rows = [r for r in rows if r.get("assigned_to_team") == assigned_team]
        if overdue_only:
            rows = [
                r for r in rows
                if r.get("next_run_at") and r["next_run_at"] < now
                and r.get("status") in {"pending", "active"}
            ]
        if due_only:
            rows = [
                r for r in rows
                if r.get("next_run_at") and r["next_run_at"] <= now
                and r.get("status") == "active"
            ]
        rows.sort(key=lambda r: (r.get("next_run_at") or "9999", r["created_at"]))
        return rows[offset:offset + limit]

    def update(self, *, tenant_id: str, task_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        allowed = set(TaskRecord.__dataclass_fields__) - {
            "task_id", "tenant_id", "created_by_user_id", "created_at", "updated_at"
        }
        with self._lock:
            rows = self._read_locked()
            for row in rows:
                if row["tenant_id"] != tenant_id or row["task_id"] != task_id:
                    continue
                for key, value in patch.items():
                    if key in allowed and value is not None:
                        row[key] = _iso(value) if key in {
                            "start_date", "due_date", "next_run_at", "last_run_at"
                        } else value
                _validate(row)
                row["updated_at"] = _now()
                self._write_locked(rows)
                return dict(row)
        return None

    def delete(self, *, tenant_id: str, task_id: str) -> bool:
        with self._lock:
            rows = self._read_locked()
            kept = [r for r in rows if not (r["tenant_id"] == tenant_id and r["task_id"] == task_id)]
            if len(kept) == len(rows):
                return False
            self._write_locked(kept)
            return True

    def _read(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._read_locked()

    def _read_locked(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines() if line]

    def _write_locked(self, rows: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, sort_keys=True, default=str) + "\n")
        tmp.replace(self.path)


_COLUMNS = ", ".join(TaskRecord.__dataclass_fields__)
_JSON_FIELDS = {"assigned_to_user_ids", "recurrence_rule", "reminder_channels", "digest_config"}
_DATE_FIELDS = {"start_date", "due_date", "next_run_at", "last_run_at", "created_at", "updated_at"}


class PostgresTasksRepository:
    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def create(self, **data: Any) -> TaskRecord:
        _validate(data)
        from psycopg.types.json import Json
        task_id = str(uuid4())
        fields = [
            "task_id", "tenant_id", "created_by_user_id", "created_by_user_name",
            "assigned_to_user_ids", "assigned_to_team", "title", "description",
            "category", "priority", "status", "recurrence_type", "recurrence_rule",
            "start_date", "due_date", "timezone", "next_run_at", "last_run_at",
            "reminder_channels", "related_module", "related_asset_id",
            "related_project_id", "related_document_id", "safety_critical",
            "compliance_critical", "digest_config",
        ]
        values = {
            **data,
            "task_id": task_id,
            "description": data.get("description") or "",
            "priority": data.get("priority") or "medium",
            "status": data.get("status") or "active",
            "recurrence_type": data.get("recurrence_type") or "none",
            "recurrence_rule": data.get("recurrence_rule") or {},
            "timezone": data.get("timezone") or "Africa/Lagos",
            "next_run_at": data.get("next_run_at") or data.get("due_date"),
            "reminder_channels": data.get("reminder_channels") or ["in_app"],
            "assigned_to_user_ids": data.get("assigned_to_user_ids") or [],
        }
        params = [Json(values[f]) if f in _JSON_FIELDS and values.get(f) is not None else values.get(f) for f in fields]
        with self._conn(data["tenant_id"]) as conn:
            row = conn.execute(
                f"INSERT INTO tasks ({', '.join(fields)}) VALUES ({', '.join(['%s'] * len(fields))}) "
                f"RETURNING {_COLUMNS}",
                params,
            ).fetchone()
        return TaskRecord(**_serialize(row))

    def get(self, *, tenant_id: str, task_id: str) -> dict[str, Any] | None:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"SELECT {_COLUMNS} FROM tasks WHERE tenant_id = %s AND task_id = %s",
                (tenant_id, task_id),
            ).fetchone()
        return _serialize(row) if row else None

    def list(
        self, *, tenant_id: str, status: str | None = None,
        category: str | None = None, assigned_user_id: str | None = None,
        assigned_team: str | None = None, overdue_only: bool = False,
        due_only: bool = False, limit: int = 100, offset: int = 0,
    ) -> list[dict[str, Any]]:
        clauses = ["tenant_id = %s"]
        params: list[Any] = [tenant_id]
        if status:
            clauses.append("status = %s"); params.append(status)
        if category:
            clauses.append("category = %s"); params.append(category)
        if assigned_user_id:
            clauses.append("assigned_to_user_ids ? %s"); params.append(assigned_user_id)
        if assigned_team:
            clauses.append("assigned_to_team = %s"); params.append(assigned_team)
        if overdue_only:
            clauses.append("next_run_at < now() AND status IN ('pending', 'active')")
        if due_only:
            clauses.append("next_run_at <= now() AND status = 'active'")
        params.extend([limit, offset])
        with self._conn(tenant_id) as conn:
            rows = conn.execute(
                f"SELECT {_COLUMNS} FROM tasks WHERE {' AND '.join(clauses)} "
                f"ORDER BY next_run_at NULLS LAST, created_at DESC LIMIT %s OFFSET %s",
                params,
            ).fetchall()
        return [_serialize(row) for row in rows]

    def update(self, *, tenant_id: str, task_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        from psycopg.types.json import Json
        allowed = set(TaskRecord.__dataclass_fields__) - {
            "task_id", "tenant_id", "created_by_user_id", "created_at", "updated_at"
        }
        items = [(k, v) for k, v in patch.items() if k in allowed and v is not None]
        if not items:
            return self.get(tenant_id=tenant_id, task_id=task_id)
        assignments, params = [], []
        for key, value in items:
            assignments.append(f"{key} = %s")
            params.append(Json(value) if key in _JSON_FIELDS else value)
        assignments.append("updated_at = now()")
        params.extend([tenant_id, task_id])
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"UPDATE tasks SET {', '.join(assignments)} "
                f"WHERE tenant_id = %s AND task_id = %s RETURNING {_COLUMNS}",
                params,
            ).fetchone()
        return _serialize(row) if row else None

    def delete(self, *, tenant_id: str, task_id: str) -> bool:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                "DELETE FROM tasks WHERE tenant_id = %s AND task_id = %s RETURNING task_id",
                (tenant_id, task_id),
            ).fetchone()
        return row is not None

    def _conn(self, tenant_id: str):
        from app.db import pg
        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in _DATE_FIELDS:
        if isinstance(out.get(key), datetime):
            out[key] = out[key].isoformat()
    for key in ("assigned_to_user_ids", "reminder_channels"):
        out[key] = list(out.get(key) or [])
    out["recurrence_rule"] = dict(out.get("recurrence_rule") or {})
    if out.get("digest_config") is not None:
        out["digest_config"] = dict(out["digest_config"])
    return out


def get_tasks_repository():
    settings = get_settings()
    if settings.persistence_backend == "postgres":
        return PostgresTasksRepository(settings.database_url)
    return LocalJsonTasksRepository(settings.tasks_store_path)
