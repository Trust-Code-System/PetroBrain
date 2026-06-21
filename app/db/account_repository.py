"""
Account settings persistence (Group 1: Profile / Settings / Org).

Backs the per-user profile + preferences (``user_settings``) and the per-tenant
organization configuration (``org_settings``) the logged-in account area edits.
Pluggable like the rest of the data layer: LocalJson in dev/tests, Postgres + RLS
in prod, identical dict shape both ways so the API doesn't care which is wired.

Tenant isolation, defence in depth: every read/write filters on tenant_id
explicitly AND (on Postgres) runs under the ``petrobrain.tenant_id`` GUC so the
RLS policies in migration 018 are the backstop. See :mod:`app.db.pg`.

Stored fields are snake_case; the route layer (routes_account) maps them to the
camelCase shape the frontend's lib/account/types.ts expects.
"""
from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from app.config import get_settings


# Honest application defaults returned when a user/tenant has no stored row yet.
# These are app defaults (not fabricated metrics) - safe to surface.
DEFAULT_USER_SETTINGS: dict[str, Any] = {
    "display_name": "",
    "avatar_url": None,
    "units": "oilfield",
    "language": "en",
    "notifications": {"product": True, "reports": True, "alerts": True},
    "opportunity_alerts": None,
}

DEFAULT_ORG_SETTINGS: dict[str, Any] = {
    "company": "",
    "country": "",
    "segment": "upstream",
    "reporting_boundary": "operational_control",
    "units": "oilfield",
    "gwp_set": "ar6",
    "frameworks": [],
}

_USER_FIELDS = tuple(DEFAULT_USER_SETTINGS.keys())
_ORG_FIELDS = tuple(DEFAULT_ORG_SETTINGS.keys())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _with_user_defaults(row: dict[str, Any] | None) -> dict[str, Any]:
    out = copy.deepcopy(DEFAULT_USER_SETTINGS)
    if row:
        for k in _USER_FIELDS:
            if row.get(k) is not None:
                out[k] = row[k]
    return out


def _with_org_defaults(row: dict[str, Any] | None) -> dict[str, Any]:
    out = copy.deepcopy(DEFAULT_ORG_SETTINGS)
    if row:
        for k in _ORG_FIELDS:
            if row.get(k) is not None:
                out[k] = row[k]
    return out


class LocalJsonAccountRepository:
    def __init__(self, user_settings_path: str | Path, org_settings_path: str | Path) -> None:
        self.user_settings_path = Path(user_settings_path)
        self.org_settings_path = Path(org_settings_path)
        self._lock = Lock()

    # ---- user settings --------------------------------------------------
    def get_user_settings(self, *, tenant_id: str, user_id: str) -> dict[str, Any]:
        for row in self._read(self.user_settings_path):
            if row["tenant_id"] == tenant_id and row["user_id"] == user_id:
                return _with_user_defaults(row)
        return _with_user_defaults(None)

    def upsert_user_settings(
        self, *, tenant_id: str, user_id: str, changes: dict[str, Any],
    ) -> dict[str, Any]:
        with self._lock:
            rows = self._read_locked(self.user_settings_path)
            now = _now()
            for row in rows:
                if row["tenant_id"] == tenant_id and row["user_id"] == user_id:
                    row.update({k: v for k, v in changes.items() if k in _USER_FIELDS})
                    row["updated_utc"] = now
                    self._write_locked(self.user_settings_path, rows)
                    return _with_user_defaults(row)
            record = {
                "tenant_id": tenant_id,
                "user_id": user_id,
                **copy.deepcopy(DEFAULT_USER_SETTINGS),
                "created_utc": now,
                "updated_utc": now,
            }
            record.update({k: v for k, v in changes.items() if k in _USER_FIELDS})
            rows.append(record)
            self._write_locked(self.user_settings_path, rows)
            return _with_user_defaults(record)

    # ---- org settings ---------------------------------------------------
    def get_org_settings(self, *, tenant_id: str) -> dict[str, Any]:
        for row in self._read(self.org_settings_path):
            if row["tenant_id"] == tenant_id:
                return _with_org_defaults(row)
        return _with_org_defaults(None)

    def upsert_org_settings(
        self, *, tenant_id: str, changes: dict[str, Any],
    ) -> dict[str, Any]:
        with self._lock:
            rows = self._read_locked(self.org_settings_path)
            now = _now()
            for row in rows:
                if row["tenant_id"] == tenant_id:
                    row.update({k: v for k, v in changes.items() if k in _ORG_FIELDS})
                    row["updated_utc"] = now
                    self._write_locked(self.org_settings_path, rows)
                    return _with_org_defaults(row)
            record = {
                "tenant_id": tenant_id,
                **copy.deepcopy(DEFAULT_ORG_SETTINGS),
                "created_utc": now,
                "updated_utc": now,
            }
            record.update({k: v for k, v in changes.items() if k in _ORG_FIELDS})
            rows.append(record)
            self._write_locked(self.org_settings_path, rows)
            return _with_org_defaults(record)

    # ---- file helpers ---------------------------------------------------
    def _read(self, path: Path) -> list[dict[str, Any]]:
        with self._lock:
            return self._read_locked(path)

    @staticmethod
    def _read_locked(path: Path) -> list[dict[str, Any]]:
        if not path.exists():
            return []
        return [
            json.loads(line)
            for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    @staticmethod
    def _write_locked(path: Path, rows: list[dict[str, Any]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, sort_keys=True) + "\n")
        tmp.replace(path)


class PostgresAccountRepository:
    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def get_user_settings(self, *, tenant_id: str, user_id: str) -> dict[str, Any]:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                "SELECT display_name, avatar_url, units, language, notifications, "
                "opportunity_alerts FROM user_settings "
                "WHERE tenant_id = %s AND user_id = %s",
                (tenant_id, user_id),
            ).fetchone()
        return _with_user_defaults(row)

    def upsert_user_settings(
        self, *, tenant_id: str, user_id: str, changes: dict[str, Any],
    ) -> dict[str, Any]:
        from psycopg.types.json import Json

        cols = {k: v for k, v in changes.items() if k in _USER_FIELDS}
        if not cols:
            return self.get_user_settings(tenant_id=tenant_id, user_id=user_id)
        names = list(cols)
        placeholders = ", ".join(["%s"] * len(names))
        updates = ", ".join(f"{n} = EXCLUDED.{n}" for n in names)
        values = [
            Json(cols[n]) if n in ("notifications", "opportunity_alerts") else cols[n]
            for n in names
        ]
        sql = (
            f"INSERT INTO user_settings (tenant_id, user_id, {', '.join(names)}) "
            f"VALUES (%s, %s, {placeholders}) "
            f"ON CONFLICT (tenant_id, user_id) DO UPDATE SET {updates}, updated_utc = now() "
            f"RETURNING display_name, avatar_url, units, language, notifications, opportunity_alerts"
        )
        with self._conn(tenant_id) as conn:
            row = conn.execute(sql, [tenant_id, user_id, *values]).fetchone()
        return _with_user_defaults(row)

    def get_org_settings(self, *, tenant_id: str) -> dict[str, Any]:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                "SELECT company, country, segment, reporting_boundary, units, "
                "gwp_set, frameworks FROM org_settings WHERE tenant_id = %s",
                (tenant_id,),
            ).fetchone()
        return _with_org_defaults(row)

    def upsert_org_settings(
        self, *, tenant_id: str, changes: dict[str, Any],
    ) -> dict[str, Any]:
        from psycopg.types.json import Json

        cols = {k: v for k, v in changes.items() if k in _ORG_FIELDS}
        if not cols:
            return self.get_org_settings(tenant_id=tenant_id)
        names = list(cols)
        placeholders = ", ".join(["%s"] * len(names))
        updates = ", ".join(f"{n} = EXCLUDED.{n}" for n in names)
        values = [Json(cols[n]) if n == "frameworks" else cols[n] for n in names]
        sql = (
            f"INSERT INTO org_settings (tenant_id, {', '.join(names)}) "
            f"VALUES (%s, {placeholders}) "
            f"ON CONFLICT (tenant_id) DO UPDATE SET {updates}, updated_utc = now() "
            f"RETURNING company, country, segment, reporting_boundary, units, gwp_set, frameworks"
        )
        with self._conn(tenant_id) as conn:
            row = conn.execute(sql, [tenant_id, *values]).fetchone()
        return _with_org_defaults(row)

    def _conn(self, tenant_id: str):
        from app.db import pg

        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def get_account_repository() -> LocalJsonAccountRepository | PostgresAccountRepository:
    settings = get_settings()
    if settings.persistence_backend == "local_json":
        return LocalJsonAccountRepository(
            settings.user_settings_store_path,
            settings.org_settings_store_path,
        )
    if settings.persistence_backend == "postgres":
        return PostgresAccountRepository(settings.database_url)
    raise ValueError(f"unknown persistence backend {settings.persistence_backend}")
