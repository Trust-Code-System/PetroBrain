"""Tenant-scoped admin notification center persistence."""
from __future__ import annotations

import builtins

import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from app.config import get_settings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class LocalJsonNotificationsRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def create(self, **data: Any) -> dict[str, Any]:
        now = _now()
        row = {
            "notification_id": str(uuid4()),
            "tenant_id": data["tenant_id"],
            "user_id": data.get("user_id"),
            "user_name": data.get("user_name"),
            "user_role": data.get("user_role"),
            "title": data["title"],
            "message": data["message"],
            "category": data.get("category") or "system",
            "severity": data.get("severity") or "info",
            "status": "unread",
            "related_audit_id": data.get("related_audit_id"),
            "related_conversation_id": data.get("related_conversation_id"),
            "related_task_id": data.get("related_task_id"),
            "related_module": data.get("related_module"),
            "triggered_rule": data.get("triggered_rule"),
            "metadata": dict(data.get("metadata") or {}),
            "created_at": now,
            "acknowledged_by": None,
            "acknowledged_at": None,
            "resolved_by": None,
            "resolved_at": None,
        }
        with self._lock:
            rows = self._read_locked()
            rows.append(row)
            self._write_locked(rows)
        return row

    def get(self, *, tenant_id: str, notification_id: str) -> dict[str, Any] | None:
        return next(
            (r for r in self._read() if r["tenant_id"] == tenant_id and r["notification_id"] == notification_id),
            None,
        )

    def list(
        self, *, tenant_id: str, status: str | None = None,
        severity: str | None = None, category: str | None = None,
        limit: int = 100, offset: int = 0,
    ) -> builtins.list[dict[str, Any]]:
        rows = [r for r in self._read() if r["tenant_id"] == tenant_id]
        if status:
            rows = [r for r in rows if r["status"] == status]
        if severity:
            rows = [r for r in rows if r["severity"] == severity]
        if category:
            rows = [r for r in rows if r["category"] == category]
        rows.sort(key=lambda r: r["created_at"], reverse=True)
        return rows[offset:offset + limit]

    def update_status(
        self, *, tenant_id: str, notification_id: str, status: str, actor_id: str,
    ) -> dict[str, Any] | None:
        if status not in {"read", "acknowledged", "resolved"}:
            raise ValueError("invalid notification status")
        with self._lock:
            rows = self._read_locked()
            for row in rows:
                if row["tenant_id"] != tenant_id or row["notification_id"] != notification_id:
                    continue
                row["status"] = status
                if status == "acknowledged":
                    row["acknowledged_by"] = actor_id
                    row["acknowledged_at"] = _now()
                if status == "resolved":
                    row["resolved_by"] = actor_id
                    row["resolved_at"] = _now()
                self._write_locked(rows)
                return dict(row)
        return None

    def delete(self, *, tenant_id: str, notification_id: str) -> bool:
        with self._lock:
            rows = self._read_locked()
            kept = [r for r in rows if not (
                r["tenant_id"] == tenant_id and r["notification_id"] == notification_id
            )]
            if len(kept) == len(rows):
                return False
            self._write_locked(kept)
            return True

    def _read(self) -> builtins.list[dict[str, Any]]:
        with self._lock:
            return self._read_locked()

    def _read_locked(self) -> builtins.list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines() if line]

    def _write_locked(self, rows: builtins.list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, sort_keys=True) + "\n")
        tmp.replace(self.path)


_COLUMNS = (
    "notification_id, tenant_id, user_id, user_name, user_role, title, message, "
    "category, severity, status, related_audit_id, related_conversation_id, "
    "related_task_id, related_module, triggered_rule, metadata, created_at, "
    "acknowledged_by, acknowledged_at, resolved_by, resolved_at"
)


class PostgresNotificationsRepository:
    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def create(self, **data: Any) -> dict[str, Any]:
        from psycopg.types.json import Json
        notification_id = str(uuid4())
        with self._conn(data["tenant_id"]) as conn:
            row = conn.execute(
                f"INSERT INTO admin_notifications "
                f"(notification_id, tenant_id, user_id, user_name, user_role, title, message, "
                f"category, severity, related_audit_id, related_conversation_id, related_task_id, "
                f"related_module, triggered_rule, metadata) "
                f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                f"RETURNING {_COLUMNS}",
                (
                    notification_id, data["tenant_id"], data.get("user_id"),
                    data.get("user_name"), data.get("user_role"), data["title"],
                    data["message"], data.get("category") or "system",
                    data.get("severity") or "info", data.get("related_audit_id"),
                    data.get("related_conversation_id"), data.get("related_task_id"),
                    data.get("related_module"), data.get("triggered_rule"),
                    Json(data.get("metadata") or {}),
                ),
            ).fetchone()
        return _serialize(row)

    def get(self, *, tenant_id: str, notification_id: str) -> dict[str, Any] | None:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"SELECT {_COLUMNS} FROM admin_notifications "
                f"WHERE tenant_id = %s AND notification_id = %s",
                (tenant_id, notification_id),
            ).fetchone()
        return _serialize(row) if row else None

    def list(
        self, *, tenant_id: str, status: str | None = None,
        severity: str | None = None, category: str | None = None,
        limit: int = 100, offset: int = 0,
    ) -> builtins.list[dict[str, Any]]:
        clauses = ["tenant_id = %s"]
        params: builtins.list[Any] = [tenant_id]
        for key, value in (("status", status), ("severity", severity), ("category", category)):
            if value:
                clauses.append(f"{key} = %s"); params.append(value)
        params.extend([limit, offset])
        with self._conn(tenant_id) as conn:
            rows = conn.execute(
                f"SELECT {_COLUMNS} FROM admin_notifications WHERE {' AND '.join(clauses)} "
                f"ORDER BY created_at DESC LIMIT %s OFFSET %s",
                params,
            ).fetchall()
        return [_serialize(row) for row in rows]

    def update_status(
        self, *, tenant_id: str, notification_id: str, status: str, actor_id: str,
    ) -> dict[str, Any] | None:
        if status not in {"read", "acknowledged", "resolved"}:
            raise ValueError("invalid notification status")
        extra = (
            ", acknowledged_by = %s, acknowledged_at = now()" if status == "acknowledged"
            else ", resolved_by = %s, resolved_at = now()" if status == "resolved"
            else ""
        )
        params: builtins.list[Any] = [status]
        if extra:
            params.append(actor_id)
        params.extend([tenant_id, notification_id])
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"UPDATE admin_notifications SET status = %s{extra} "
                f"WHERE tenant_id = %s AND notification_id = %s RETURNING {_COLUMNS}",
                params,
            ).fetchone()
        return _serialize(row) if row else None

    def delete(self, *, tenant_id: str, notification_id: str) -> bool:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                "DELETE FROM admin_notifications WHERE tenant_id = %s "
                "AND notification_id = %s RETURNING notification_id",
                (tenant_id, notification_id),
            ).fetchone()
        return row is not None

    def _conn(self, tenant_id: str):
        from app.db import pg
        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in ("created_at", "acknowledged_at", "resolved_at"):
        if isinstance(out.get(key), datetime):
            out[key] = out[key].isoformat()
    out["metadata"] = dict(out.get("metadata") or {})
    return out


def get_notifications_repository():
    settings = get_settings()
    if settings.persistence_backend == "postgres":
        return PostgresNotificationsRepository(settings.database_url)
    return LocalJsonNotificationsRepository(settings.admin_notifications_store_path)
