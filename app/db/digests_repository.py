"""Tenant-scoped persistence for safe scheduled research digest definitions."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from app.config import get_settings


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class LocalJsonDigestsRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def create(self, **data: Any) -> dict[str, Any]:
        now = _now()
        row = {
            "digest_id": str(uuid4()),
            "tenant_id": data["tenant_id"],
            "created_by_user_id": data["created_by_user_id"],
            "title": data["title"],
            "topics": list(data.get("topics") or []),
            "sources_allowed": list(data.get("sources_allowed") or []),
            "domains_allowed": list(data.get("domains_allowed") or []),
            "recurrence_rule": dict(data.get("recurrence_rule") or {}),
            "next_run_at": data.get("next_run_at"),
            "output_format": data.get("output_format") or "research_draft",
            "recipients": list(data.get("recipients") or []),
            "status": data.get("status") or "active",
            "last_run_summary": None,
            "task_id": data.get("task_id"),
            "created_at": now,
            "updated_at": now,
        }
        with self._lock:
            rows = self._read_locked()
            rows.append(row)
            self._write_locked(rows)
        return row

    def list(self, *, tenant_id: str) -> list[dict[str, Any]]:
        return [row for row in self._read() if row["tenant_id"] == tenant_id]

    def _read(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._read_locked()

    def _read_locked(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [
            json.loads(line)
            for line in self.path.read_text(encoding="utf-8").splitlines()
            if line
        ]

    def _write_locked(self, rows: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, sort_keys=True, default=str) + "\n")
        tmp.replace(self.path)


class PostgresDigestsRepository:
    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def create(self, **data: Any) -> dict[str, Any]:
        from psycopg.types.json import Json

        digest_id = str(uuid4())
        with self._conn(data["tenant_id"]) as conn:
            row = conn.execute(
                """
                INSERT INTO scheduled_digests
                (digest_id, tenant_id, created_by_user_id, title, topics,
                 sources_allowed, domains_allowed, recurrence_rule, next_run_at,
                 output_format, recipients, status, task_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING *
                """,
                (
                    digest_id, data["tenant_id"], data["created_by_user_id"],
                    data["title"], Json(data.get("topics") or []),
                    Json(data.get("sources_allowed") or []),
                    Json(data.get("domains_allowed") or []),
                    Json(data.get("recurrence_rule") or {}),
                    data.get("next_run_at"),
                    data.get("output_format") or "research_draft",
                    Json(data.get("recipients") or []),
                    data.get("status") or "active", data.get("task_id"),
                ),
            ).fetchone()
        return _serialize(row)

    def list(self, *, tenant_id: str) -> list[dict[str, Any]]:
        with self._conn(tenant_id) as conn:
            rows = conn.execute(
                "SELECT * FROM scheduled_digests WHERE tenant_id = %s "
                "ORDER BY created_at DESC",
                (tenant_id,),
            ).fetchall()
        return [_serialize(row) for row in rows]

    def _conn(self, tenant_id: str):
        from app.db import pg
        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in ("next_run_at", "created_at", "updated_at"):
        if isinstance(out.get(key), datetime):
            out[key] = out[key].isoformat()
    for key in ("topics", "sources_allowed", "domains_allowed", "recipients"):
        out[key] = list(out.get(key) or [])
    out["recurrence_rule"] = dict(out.get("recurrence_rule") or {})
    return out


def get_digests_repository():
    settings = get_settings()
    if settings.persistence_backend == "postgres":
        return PostgresDigestsRepository(settings.database_url)
    return LocalJsonDigestsRepository(settings.scheduled_digests_store_path)
