"""Tenant-scoped persistence for Research Mode plans, runs, events, and reports."""
from __future__ import annotations

import builtins

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from app.config import get_settings


@dataclass
class ResearchRecord:
    id: str
    tenant_id: str
    user_id: str
    role: str
    status: str
    query: str
    config: dict[str, Any]
    plan: builtins.list[dict[str, Any]]
    sources: builtins.list[dict[str, Any]] = field(default_factory=list)
    report: dict[str, Any] | None = None
    evidence_pack: dict[str, Any] = field(default_factory=dict)
    events: builtins.list[dict[str, Any]] = field(default_factory=list)
    flags: builtins.list[str] = field(default_factory=list)
    error: str | None = None
    created_utc: str = ""
    updated_utc: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class LocalJsonResearchRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def create(
        self,
        *,
        tenant_id: str,
        user_id: str,
        role: str,
        query: str,
        config: dict[str, Any],
        plan: builtins.list[dict[str, Any]],
    ) -> ResearchRecord:
        if not tenant_id or not user_id:
            raise ValueError("tenant_id and user_id are required")
        now = _now()
        record = ResearchRecord(
            id=str(uuid4()),
            tenant_id=tenant_id,
            user_id=user_id,
            role=role,
            status="plan_ready",
            query=query,
            config=dict(config),
            plan=list(plan),
            created_utc=now,
            updated_utc=now,
        )
        with self._lock:
            rows = self._read_all_locked()
            rows.append(record.as_dict())
            self._write_all_locked(rows)
        return record

    def get(self, *, tenant_id: str, research_id: str) -> dict[str, Any] | None:
        return next(
            (
                row
                for row in self._read_all()
                if row.get("tenant_id") == tenant_id and row.get("id") == research_id
            ),
            None,
        )

    def list(
        self,
        *,
        tenant_id: str,
        user_id: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> builtins.list[dict[str, Any]]:
        rows = [row for row in self._read_all() if row.get("tenant_id") == tenant_id]
        if user_id:
            rows = [row for row in rows if row.get("user_id") == user_id]
        rows.sort(key=lambda row: row.get("updated_utc") or "", reverse=True)
        return rows[offset:offset + limit]

    def update(
        self, *, tenant_id: str, research_id: str, patch: dict[str, Any]
    ) -> dict[str, Any] | None:
        with self._lock:
            rows = self._read_all_locked()
            for row in rows:
                if row.get("tenant_id") != tenant_id or row.get("id") != research_id:
                    continue
                for key, value in patch.items():
                    if key not in {"id", "tenant_id", "user_id", "created_utc"}:
                        row[key] = value
                row["updated_utc"] = _now()
                self._write_all_locked(rows)
                return dict(row)
        return None

    def append_event(
        self,
        *,
        tenant_id: str,
        research_id: str,
        event: str,
        data: dict[str, Any],
    ) -> dict[str, Any] | None:
        record = self.get(tenant_id=tenant_id, research_id=research_id)
        if record is None:
            return None
        events = list(record.get("events") or [])
        item = {"sequence": len(events) + 1, "event": event, "data": data, "ts": _now()}
        events.append(item)
        self.update(
            tenant_id=tenant_id,
            research_id=research_id,
            patch={"events": events},
        )
        return item

    def delete(self, *, tenant_id: str, research_id: str) -> bool:
        with self._lock:
            rows = self._read_all_locked()
            kept = [
                row
                for row in rows
                if not (
                    row.get("tenant_id") == tenant_id and row.get("id") == research_id
                )
            ]
            if len(kept) == len(rows):
                return False
            self._write_all_locked(kept)
            return True

    def _read_all(self) -> builtins.list[dict[str, Any]]:
        with self._lock:
            return self._read_all_locked()

    def _read_all_locked(self) -> builtins.list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [
            json.loads(line)
            for line in self.path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def _write_all_locked(self, rows: builtins.list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, sort_keys=True, default=str) + "\n")
        tmp.replace(self.path)


_COLUMNS = (
    "id, tenant_id, user_id, role, status, query, config, plan, sources, "
    "report, evidence_pack, events, flags, error, created_utc, updated_utc"
)


class PostgresResearchRepository:
    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def create(
        self,
        *,
        tenant_id: str,
        user_id: str,
        role: str,
        query: str,
        config: dict[str, Any],
        plan: builtins.list[dict[str, Any]],
    ) -> ResearchRecord:
        from psycopg.types.json import Json

        research_id = str(uuid4())
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"INSERT INTO research_runs "
                f"(id, tenant_id, user_id, role, status, query, config, plan) "
                f"VALUES (%s, %s, %s, %s, 'plan_ready', %s, %s, %s) "
                f"RETURNING {_COLUMNS}",
                (
                    research_id,
                    tenant_id,
                    user_id,
                    role,
                    query,
                    Json(config),
                    Json(plan),
                ),
            ).fetchone()
        return _record_from_row(row)

    def get(self, *, tenant_id: str, research_id: str) -> dict[str, Any] | None:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"SELECT {_COLUMNS} FROM research_runs "
                f"WHERE tenant_id = %s AND id = %s",
                (tenant_id, research_id),
            ).fetchone()
        return _serialize(row) if row else None

    def list(
        self,
        *,
        tenant_id: str,
        user_id: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> builtins.list[dict[str, Any]]:
        clauses = ["tenant_id = %s"]
        params: builtins.list[Any] = [tenant_id]
        if user_id:
            clauses.append("user_id = %s")
            params.append(user_id)
        params.extend([limit, offset])
        with self._conn(tenant_id) as conn:
            rows = conn.execute(
                f"SELECT {_COLUMNS} FROM research_runs "
                f"WHERE {' AND '.join(clauses)} "
                f"ORDER BY updated_utc DESC LIMIT %s OFFSET %s",
                params,
            ).fetchall()
        return [_serialize(row) for row in rows]

    def update(
        self, *, tenant_id: str, research_id: str, patch: dict[str, Any]
    ) -> dict[str, Any] | None:
        from psycopg.types.json import Json

        allowed = {
            "status",
            "query",
            "config",
            "plan",
            "sources",
            "report",
            "evidence_pack",
            "events",
            "flags",
            "error",
        }
        items = [(key, value) for key, value in patch.items() if key in allowed]
        if not items:
            return self.get(tenant_id=tenant_id, research_id=research_id)
        assignments: builtins.list[str] = []
        params: builtins.list[Any] = []
        json_fields = {
            "config",
            "plan",
            "sources",
            "report",
            "evidence_pack",
            "events",
            "flags",
        }
        for key, value in items:
            assignments.append(f"{key} = %s")
            params.append(Json(value) if key in json_fields else value)
        assignments.append("updated_utc = now()")
        params.extend([tenant_id, research_id])
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"UPDATE research_runs SET {', '.join(assignments)} "
                f"WHERE tenant_id = %s AND id = %s RETURNING {_COLUMNS}",
                params,
            ).fetchone()
        return _serialize(row) if row else None

    def append_event(
        self,
        *,
        tenant_id: str,
        research_id: str,
        event: str,
        data: dict[str, Any],
    ) -> dict[str, Any] | None:
        from psycopg.types.json import Json

        with self._conn(tenant_id) as conn:
            current = conn.execute(
                "SELECT events FROM research_runs WHERE tenant_id = %s AND id = %s",
                (tenant_id, research_id),
            ).fetchone()
            if current is None:
                return None
            events = list(current.get("events") or [])
            item = {
                "sequence": len(events) + 1,
                "event": event,
                "data": data,
                "ts": _now(),
            }
            events.append(item)
            conn.execute(
                "UPDATE research_runs SET events = %s, updated_utc = now() "
                "WHERE tenant_id = %s AND id = %s",
                (Json(events), tenant_id, research_id),
            )
        return item

    def delete(self, *, tenant_id: str, research_id: str) -> bool:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                "DELETE FROM research_runs WHERE tenant_id = %s AND id = %s RETURNING id",
                (tenant_id, research_id),
            ).fetchone()
        return row is not None

    def _conn(self, tenant_id: str):
        from app.db import pg

        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in ("created_utc", "updated_utc"):
        value = out.get(key)
        if value is not None and not isinstance(value, str):
            out[key] = value.isoformat()
    for key, empty in (
        ("config", {}),
        ("plan", []),
        ("sources", []),
        ("evidence_pack", {}),
        ("events", []),
        ("flags", []),
    ):
        out[key] = type(empty)(out.get(key) or empty)
    if out.get("report") is not None:
        out["report"] = dict(out["report"])
    return out


def _record_from_row(row: dict[str, Any]) -> ResearchRecord:
    value = _serialize(row)
    return ResearchRecord(**value)


def get_research_repository() -> LocalJsonResearchRepository | PostgresResearchRepository:
    settings = get_settings()
    if settings.persistence_backend == "local_json":
        return LocalJsonResearchRepository(settings.research_store_path)
    if settings.persistence_backend == "postgres":
        return PostgresResearchRepository(settings.database_url)
    raise ValueError(f"unknown persistence backend {settings.persistence_backend}")
