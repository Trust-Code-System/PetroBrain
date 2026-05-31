"""
Permit (PTW) registry - receives permits flushed from the field app's offline
outgoing_queue.

Production swap point is the ``permits`` table (migration 008). Phase-1 ships a
JSONL backend. ``upsert`` is idempotent on the device-generated id so a retried
flush does not duplicate. Tenant isolation: in-app filtering AND Postgres RLS.
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
class PermitRecord:
    id: str
    tenant_id: str
    user_id: str
    format: str
    status: str
    form: dict[str, Any] = field(default_factory=dict)
    generated: dict[str, Any] = field(default_factory=dict)
    signatures: list[dict[str, Any]] = field(default_factory=list)
    created_utc: str | None = None
    synced_utc: str = ""
    updated_utc: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class LocalJsonPermitsRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def upsert(self, *, tenant_id: str, user_id: str, permit: dict[str, Any]) -> PermitRecord:
        if not tenant_id or not user_id:
            raise ValueError("tenant_id and user_id are required")
        if not permit.get("id"):
            raise ValueError("permit id is required")
        now = _now()
        with self._lock:
            rows = self._read_all_locked()
            existing = next(
                (r for r in rows if r["tenant_id"] == tenant_id and r["id"] == permit["id"]), None
            )
            created = (existing or {}).get("created_utc") or permit.get("created_utc") or now
            record = PermitRecord(
                id=permit["id"], tenant_id=tenant_id, user_id=user_id,
                format=permit.get("format") or "ptw",
                status=permit.get("status") or "submitted",
                form=dict(permit.get("form") or {}),
                generated=dict(permit.get("generated") or {}),
                signatures=list(permit.get("signatures") or []),
                created_utc=created,
                synced_utc=(existing or {}).get("synced_utc") or now,
                updated_utc=now,
            )
            rows = [r for r in rows if not (r["tenant_id"] == tenant_id and r["id"] == permit["id"])]
            rows.append(record.as_dict())
            self._write_all_locked(rows)
            return record

    def list_records(self, *, tenant_id: str) -> list[dict[str, Any]]:
        if not tenant_id:
            raise ValueError("tenant_id is required")
        rows = [r for r in self._read_all() if r.get("tenant_id") == tenant_id]
        return sorted(rows, key=lambda r: r.get("created_utc") or "", reverse=True)

    def get(self, *, tenant_id: str, permit_id: str) -> dict[str, Any] | None:
        for r in self._read_all():
            if r.get("tenant_id") == tenant_id and r.get("id") == permit_id:
                return r
        return None

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

    def _write_all_locked(self, rows: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, sort_keys=True) + "\n")
        tmp.replace(self.path)


_PERMIT_COLUMNS = (
    "id, tenant_id, user_id, format, status, form, generated, signatures, "
    "created_utc, synced_utc, updated_utc"
)


class PostgresPermitsRepository:
    """Postgres backend for permits (migration 008), drop-in for the LocalJson
    repo. ``upsert`` is an INSERT ... ON CONFLICT (id) DO UPDATE so a retried
    flush is idempotent. Tenant isolation via explicit filter + the GUC."""

    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def upsert(self, *, tenant_id: str, user_id: str, permit: dict[str, Any]) -> PermitRecord:
        if not tenant_id or not user_id:
            raise ValueError("tenant_id and user_id are required")
        if not permit.get("id"):
            raise ValueError("permit id is required")
        from psycopg.types.json import Json

        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"INSERT INTO permits (id, tenant_id, user_id, format, status, form, "
                f" generated, signatures, created_utc) "
                f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, COALESCE(%s, now())) "
                f"ON CONFLICT (id) DO UPDATE SET "
                f"  status = EXCLUDED.status, form = EXCLUDED.form, "
                f"  generated = EXCLUDED.generated, signatures = EXCLUDED.signatures, "
                f"  updated_utc = now() "
                f"RETURNING {_PERMIT_COLUMNS}",
                (
                    permit["id"], tenant_id, user_id, permit.get("format") or "ptw",
                    permit.get("status") or "submitted",
                    Json(dict(permit.get("form") or {})),
                    Json(dict(permit.get("generated") or {})),
                    Json(list(permit.get("signatures") or [])),
                    permit.get("created_utc"),
                ),
            ).fetchone()
        return _record_from_row(row)

    def list_records(self, *, tenant_id: str) -> list[dict[str, Any]]:
        if not tenant_id:
            raise ValueError("tenant_id is required")
        with self._conn(tenant_id) as conn:
            rows = conn.execute(
                f"SELECT {_PERMIT_COLUMNS} FROM permits WHERE tenant_id = %s "
                f"ORDER BY created_utc DESC NULLS LAST",
                (tenant_id,),
            ).fetchall()
        return [_serialize_permit(r) for r in rows]

    def get(self, *, tenant_id: str, permit_id: str) -> dict[str, Any] | None:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"SELECT {_PERMIT_COLUMNS} FROM permits WHERE tenant_id = %s AND id = %s",
                (tenant_id, permit_id),
            ).fetchone()
        return _serialize_permit(row) if row else None

    def _conn(self, tenant_id: str):
        from app.db import pg

        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def _serialize_permit(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in ("created_utc", "synced_utc", "updated_utc"):
        value = out.get(key)
        if value is not None and not isinstance(value, str):
            out[key] = value.isoformat()
    out["form"] = dict(out.get("form") or {})
    out["generated"] = dict(out.get("generated") or {})
    out["signatures"] = list(out.get("signatures") or [])
    return out


def _record_from_row(row: dict[str, Any]) -> PermitRecord:
    d = _serialize_permit(row)
    return PermitRecord(
        id=d["id"], tenant_id=d["tenant_id"], user_id=d["user_id"], format=d["format"],
        status=d["status"], form=d["form"], generated=d["generated"],
        signatures=d["signatures"], created_utc=d.get("created_utc"),
        synced_utc=d.get("synced_utc", ""), updated_utc=d.get("updated_utc", ""),
    )


def get_permits_repository() -> LocalJsonPermitsRepository | PostgresPermitsRepository:
    settings = get_settings()
    if settings.persistence_backend == "local_json":
        return LocalJsonPermitsRepository(settings.permits_store_path)
    if settings.persistence_backend == "postgres":
        return PostgresPermitsRepository(settings.database_url)
    raise ValueError(f"unknown persistence backend {settings.persistence_backend}")
