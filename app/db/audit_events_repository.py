"""
Production-shape audit events store (A6).

Schema mirrors ``app/db/migrations/002_audit_events.sql`` exactly so the
Postgres swap is a backend change, not a model change. The Phase-1 backend
is JSONL - append-only writes, in-app tenant filtering on read. The Postgres
backend (deferred) enforces the same tenant scoping at the DB layer via RLS.

Raw user text and raw model output MUST NEVER pass through this module.
``AuditEvent.append`` accepts hash strings only.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from app.config import get_settings


@dataclass
class AuditEventRow:
    id: int
    ts: str                          # ISO-8601 TIMESTAMPTZ
    tenant_id: str
    user_id: str
    role: str
    action: str                      # "chat" | "tool:<name>"
    module: str                      # "general" | "well_control" | "emissions_mrv" | ...
    request_hash: str                # sha256 hex
    response_hash: str               # sha256 hex (empty on error)
    retrieved_clauses: list[Any] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class LocalJsonAuditEventsRepository:
    """
    JSONL repository for Phase-1. Append-only.

    Tenant isolation is enforced in app code on every read; the Postgres
    swap point delegates the same contract to RLS. A misrouted query that
    forgets the tenant_id filter returns nothing instead of leaking.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def append(
        self,
        *,
        tenant_id: str,
        user_id: str,
        role: str,
        action: str,
        module: str,
        request_hash: str,
        response_hash: str,
        retrieved_clauses: list[Any] | None = None,
        flags: list[str] | None = None,
        usage: dict[str, Any] | None = None,
        ts: datetime | None = None,
    ) -> AuditEventRow:
        if not tenant_id:
            raise ValueError("tenant_id is required for audit_events.append")
        if not request_hash or not isinstance(request_hash, str):
            raise ValueError("request_hash must be a non-empty sha256 hex string")
        if response_hash is None or not isinstance(response_hash, str):
            raise ValueError("response_hash must be a string (empty allowed on error)")
        row_ts = (ts or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()
        with self._lock:
            next_id = self._next_id_locked()
            row = AuditEventRow(
                id=next_id,
                ts=row_ts,
                tenant_id=tenant_id,
                user_id=user_id,
                role=role,
                action=action,
                module=module,
                request_hash=request_hash,
                response_hash=response_hash,
                retrieved_clauses=list(retrieved_clauses or []),
                flags=list(flags or []),
                usage=dict(usage or {}),
            )
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row.as_dict(), sort_keys=True) + "\n")
        return row

    def query(
        self,
        *,
        tenant_id: str,
        from_ts: datetime | None = None,
        to_ts: datetime | None = None,
        user_id: str | None = None,
        module: str | None = None,
        action: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        if not tenant_id:
            raise ValueError("tenant_id is required for audit_events.query")
        if limit <= 0 or limit > 500:
            raise ValueError("limit must be 1..500")
        if offset < 0:
            raise ValueError("offset must be >= 0")
        from_iso = _to_iso(from_ts)
        to_iso = _to_iso(to_ts)
        rows = [r for r in self._read_all() if r.get("tenant_id") == tenant_id]
        if from_iso is not None:
            rows = [r for r in rows if r["ts"] >= from_iso]
        if to_iso is not None:
            rows = [r for r in rows if r["ts"] <= to_iso]
        if user_id:
            rows = [r for r in rows if r.get("user_id") == user_id]
        if module:
            rows = [r for r in rows if r.get("module") == module]
        if action:
            rows = [r for r in rows if r.get("action") == action]
        rows.sort(key=lambda r: (r["ts"], r["id"]), reverse=True)
        return rows[offset:offset + limit]

    def count(self, *, tenant_id: str) -> int:
        if not tenant_id:
            raise ValueError("tenant_id is required for audit_events.count")
        return sum(1 for r in self._read_all() if r.get("tenant_id") == tenant_id)

    def _next_id_locked(self) -> int:
        max_id = 0
        for r in self._read_all_locked():
            row_id = r.get("id", 0)
            if isinstance(row_id, int) and row_id > max_id:
                max_id = row_id
        return max_id + 1

    def _read_all(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._read_all_locked()

    def _read_all_locked(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [
            json.loads(line)
            for line in self.path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]


_AUDIT_COLUMNS = (
    "id, ts, tenant_id, user_id, role, action, module, "
    "request_hash, response_hash, retrieved_clauses, flags, usage"
)


class PostgresAuditEventsRepository:
    """Postgres backend for audit_events (migration 002), drop-in compatible
    with :class:`LocalJsonAuditEventsRepository`.

    Append-only by design: this class only ever issues INSERT/SELECT. Migration
    002 also REVOKEs UPDATE/DELETE from PUBLIC; in production grant the app role
    only SELECT, INSERT on this table. The RLS policy here has NO ``'*'`` bypass,
    so a platform-admin reading another tenant's log sets the GUC to that exact
    tenant_id (handled by passing the chosen tenant_id through ``query``).
    """

    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def append(
        self, *, tenant_id: str, user_id: str, role: str, action: str, module: str,
        request_hash: str, response_hash: str,
        retrieved_clauses: list[Any] | None = None,
        flags: list[str] | None = None,
        usage: dict[str, Any] | None = None,
        ts: datetime | None = None,
    ) -> AuditEventRow:
        if not tenant_id:
            raise ValueError("tenant_id is required for audit_events.append")
        if not request_hash or not isinstance(request_hash, str):
            raise ValueError("request_hash must be a non-empty sha256 hex string")
        if response_hash is None or not isinstance(response_hash, str):
            raise ValueError("response_hash must be a string (empty allowed on error)")
        from psycopg.types.json import Json

        with self._tenant_conn(tenant_id) as conn:
            row = conn.execute(
                f"INSERT INTO audit_events "
                f"(ts, tenant_id, user_id, role, action, module, request_hash, "
                f" response_hash, retrieved_clauses, flags, usage) "
                f"VALUES (COALESCE(%s, now()), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                f"RETURNING {_AUDIT_COLUMNS}",
                (ts, tenant_id, user_id, role, action, module, request_hash,
                 response_hash, Json(list(retrieved_clauses or [])),
                 Json(list(flags or [])), Json(dict(usage or {}))),
            ).fetchone()
        return _row_to_event(row)

    def query(
        self, *, tenant_id: str,
        from_ts: datetime | None = None, to_ts: datetime | None = None,
        user_id: str | None = None, module: str | None = None,
        action: str | None = None, limit: int = 50, offset: int = 0,
    ) -> list[dict[str, Any]]:
        if not tenant_id:
            raise ValueError("tenant_id is required for audit_events.query")
        if limit <= 0 or limit > 500:
            raise ValueError("limit must be 1..500")
        if offset < 0:
            raise ValueError("offset must be >= 0")
        clauses = ["tenant_id = %s"]
        params: list[Any] = [tenant_id]
        if from_ts is not None:
            clauses.append("ts >= %s")
            params.append(from_ts)
        if to_ts is not None:
            clauses.append("ts <= %s")
            params.append(to_ts)
        if user_id:
            clauses.append("user_id = %s")
            params.append(user_id)
        if module:
            clauses.append("module = %s")
            params.append(module)
        if action:
            clauses.append("action = %s")
            params.append(action)
        sql = (
            f"SELECT {_AUDIT_COLUMNS} FROM audit_events WHERE {' AND '.join(clauses)} "
            f"ORDER BY ts DESC, id DESC LIMIT %s OFFSET %s"
        )
        params.extend([limit, offset])
        with self._tenant_conn(tenant_id) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_serialize_event(r) for r in rows]

    def count(self, *, tenant_id: str) -> int:
        if not tenant_id:
            raise ValueError("tenant_id is required for audit_events.count")
        with self._tenant_conn(tenant_id) as conn:
            row = conn.execute(
                "SELECT count(*) AS n FROM audit_events WHERE tenant_id = %s", (tenant_id,)
            ).fetchone()
        return int(row["n"])

    def _tenant_conn(self, tenant_id: str):
        from app.db import pg

        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def _serialize_event(row: dict[str, Any]) -> dict[str, Any]:
    """Match LocalJson's dict shape: ISO-8601 string for ts; jsonb already
    decodes to Python list/dict via psycopg."""
    out = dict(row)
    ts = out.get("ts")
    if ts is not None and not isinstance(ts, str):
        out["ts"] = ts.isoformat()
    return out


def _row_to_event(row: dict[str, Any]) -> AuditEventRow:
    data = _serialize_event(row)
    return AuditEventRow(
        id=data["id"], ts=data["ts"], tenant_id=data["tenant_id"],
        user_id=data["user_id"], role=data["role"], action=data["action"],
        module=data["module"], request_hash=data["request_hash"],
        response_hash=data["response_hash"],
        retrieved_clauses=list(data.get("retrieved_clauses") or []),
        flags=list(data.get("flags") or []),
        usage=dict(data.get("usage") or {}),
    )


def get_audit_events_repository() -> LocalJsonAuditEventsRepository | PostgresAuditEventsRepository:
    settings = get_settings()
    if settings.persistence_backend == "local_json":
        return LocalJsonAuditEventsRepository(settings.audit_events_store_path)
    if settings.persistence_backend == "postgres":
        return PostgresAuditEventsRepository(settings.database_url)
    raise ValueError(f"unknown persistence backend {settings.persistence_backend}")


def _to_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()
