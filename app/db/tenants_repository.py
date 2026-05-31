"""
Tenant registry (B8).

Production swap point is the ``tenants`` table from
``app/db/migrations/004_tenants_users.sql``. Phase-1 ships a JSONL
backend so the admin console can be exercised end-to-end without
running Postgres.

Only platform admins are expected to write here. Tenant admins read
their own row via ``get`` filtered by the principal's tenant_id.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from app.config import get_settings


STATUSES = ("active", "suspended")


@dataclass
class TenantRecord:
    id: str
    name: str
    status: str
    attributes: dict[str, Any] = field(default_factory=dict)
    created_utc: str = ""
    updated_utc: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class LocalJsonTenantsRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def create(self, *, id: str, name: str,
               attributes: dict[str, Any] | None = None,
               status: str = "active") -> TenantRecord:
        if not id or not name:
            raise ValueError("id and name are required")
        if status not in STATUSES:
            raise ValueError(f"unknown status: {status}")
        now = _now()
        with self._lock:
            rows = self._read_all_locked()
            if any(r["id"] == id for r in rows):
                raise ValueError(f"tenant id {id!r} already exists")
            record = TenantRecord(
                id=id, name=name, status=status,
                attributes=dict(attributes or {}),
                created_utc=now, updated_utc=now,
            )
            rows.append(record.as_dict())
            self._write_all_locked(rows)
            return record

    def get(self, id: str) -> dict[str, Any] | None:
        for row in self._read_all():
            if row["id"] == id:
                return row
        return None

    def list_records(self, *, status: str | None = None) -> list[dict[str, Any]]:
        rows = self._read_all()
        if status is not None:
            rows = [r for r in rows if r["status"] == status]
        return sorted(rows, key=lambda r: r["created_utc"])

    def update(self, id: str, *, name: str | None = None,
               status: str | None = None,
               attributes: dict[str, Any] | None = None) -> dict[str, Any]:
        if status is not None and status not in STATUSES:
            raise ValueError(f"unknown status: {status}")
        with self._lock:
            rows = self._read_all_locked()
            for row in rows:
                if row["id"] != id:
                    continue
                if name is not None:
                    if not name.strip():
                        raise ValueError("name must not be empty")
                    row["name"] = name
                if status is not None:
                    row["status"] = status
                if attributes is not None:
                    row["attributes"] = dict(attributes)
                row["updated_utc"] = _now()
                self._write_all_locked(rows)
                return row
        raise KeyError(f"tenant {id!r} not found")

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


_TENANT_COLUMNS = "id, name, status, attributes, created_utc, updated_utc"


class PostgresTenantsRepository:
    """Postgres backend for the tenants table (migration 004), drop-in compatible
    with :class:`LocalJsonTenantsRepository`.

    The tenants table is the platform registry: its RLS policy is keyed on the
    row ``id`` with a ``'*'`` platform-admin bypass, and only platform admins
    write here (enforced by the route layer). This repo therefore connects with
    the GUC set to ``'*'`` - mirroring LocalJson, which does no repo-level
    filtering. The RLS policy still exists as defence in depth; a tenant admin
    reading its own row would connect with the GUC set to its own tenant_id.
    """

    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def create(self, *, id: str, name: str,
               attributes: dict[str, Any] | None = None,
               status: str = "active") -> TenantRecord:
        if not id or not name:
            raise ValueError("id and name are required")
        if status not in STATUSES:
            raise ValueError(f"unknown status: {status}")
        from psycopg import errors
        from psycopg.types.json import Json

        try:
            with self._admin_conn() as conn:
                row = conn.execute(
                    f"INSERT INTO tenants (id, name, status, attributes) "
                    f"VALUES (%s, %s, %s, %s) RETURNING {_TENANT_COLUMNS}",
                    (id, name, status, Json(dict(attributes or {}))),
                ).fetchone()
        except errors.UniqueViolation as exc:
            raise ValueError(f"tenant id {id!r} already exists") from exc
        return _record_from_row(row)

    def get(self, id: str) -> dict[str, Any] | None:
        with self._admin_conn() as conn:
            row = conn.execute(
                f"SELECT {_TENANT_COLUMNS} FROM tenants WHERE id = %s", (id,)
            ).fetchone()
        return _serialize_tenant(row) if row else None

    def list_records(self, *, status: str | None = None) -> list[dict[str, Any]]:
        sql = f"SELECT {_TENANT_COLUMNS} FROM tenants"
        params: list[Any] = []
        if status is not None:
            sql += " WHERE status = %s"
            params.append(status)
        sql += " ORDER BY created_utc"
        with self._admin_conn() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_serialize_tenant(r) for r in rows]

    def update(self, id: str, *, name: str | None = None,
               status: str | None = None,
               attributes: dict[str, Any] | None = None) -> dict[str, Any]:
        if status is not None and status not in STATUSES:
            raise ValueError(f"unknown status: {status}")
        if name is not None and not name.strip():
            raise ValueError("name must not be empty")
        from psycopg.types.json import Json

        assignments = []
        params: list[Any] = []
        if name is not None:
            assignments.append("name = %s")
            params.append(name)
        if status is not None:
            assignments.append("status = %s")
            params.append(status)
        if attributes is not None:
            assignments.append("attributes = %s")
            params.append(Json(dict(attributes)))
        assignments.append("updated_utc = now()")
        params.append(id)
        sql = (
            f"UPDATE tenants SET {', '.join(assignments)} "
            f"WHERE id = %s RETURNING {_TENANT_COLUMNS}"
        )
        with self._admin_conn() as conn:
            row = conn.execute(sql, params).fetchone()
        if row is None:
            raise KeyError(f"tenant {id!r} not found")
        return _serialize_tenant(row)

    def _admin_conn(self):
        from app.db import pg

        return pg.tenant_connection(pg.PLATFORM_ADMIN_TENANT, dsn=self.dsn, dict_rows=True)


def _serialize_tenant(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in ("created_utc", "updated_utc"):
        value = out.get(key)
        if value is not None and not isinstance(value, str):
            out[key] = value.isoformat()
    return out


def _record_from_row(row: dict[str, Any]) -> TenantRecord:
    data = _serialize_tenant(row)
    return TenantRecord(
        id=data["id"], name=data["name"], status=data["status"],
        attributes=dict(data.get("attributes") or {}),
        created_utc=data.get("created_utc", ""),
        updated_utc=data.get("updated_utc", ""),
    )


def get_tenants_repository() -> LocalJsonTenantsRepository | PostgresTenantsRepository:
    settings = get_settings()
    if settings.persistence_backend == "local_json":
        return LocalJsonTenantsRepository(settings.tenants_store_path)
    if settings.persistence_backend == "postgres":
        return PostgresTenantsRepository(settings.database_url)
    raise ValueError(f"unknown persistence backend {settings.persistence_backend}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
