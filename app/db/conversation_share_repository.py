"""
Conversation-share registry.

The frontend snapshots a conversation client-side (the chat history lives in
sessionStorage, not in the backend) and POSTs it here. We store the snapshot
verbatim and hand back an opaque token. Readers come in via
``GET /chat/shares/{token}`` - that route re-checks tenant_id against the
caller's principal AND lets RLS act as the backstop.

Mirrors the existing repository pattern: LocalJson Phase-1 backend, Postgres
swap-in via :class:`PostgresConversationShareRepository`, factory chooses by
``settings.persistence_backend``.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any

from app.config import get_settings


SHARE_TTL_DAYS = 30


@dataclass
class ShareRecord:
    token: str
    tenant_id: str
    created_by: str
    title: str
    snapshot: dict[str, Any] = field(default_factory=dict)
    created_utc: str = ""
    expires_utc: str = ""
    revoked_utc: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def is_active(self) -> bool:
        if self.revoked_utc:
            return False
        try:
            return datetime.fromisoformat(self.expires_utc) > datetime.now(timezone.utc)
        except (ValueError, TypeError):
            return False


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


class LocalJsonConversationShareRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def create(self, *, token: str, tenant_id: str, created_by: str,
               title: str, snapshot: dict[str, Any],
               ttl_days: int = SHARE_TTL_DAYS) -> ShareRecord:
        if not token or not tenant_id or not created_by:
            raise ValueError("token, tenant_id, created_by are required")
        now = _now()
        record = ShareRecord(
            token=token,
            tenant_id=tenant_id,
            created_by=created_by,
            title=title or "Untitled conversation",
            snapshot=dict(snapshot or {}),
            created_utc=_iso(now),
            expires_utc=_iso(now + timedelta(days=ttl_days)),
            revoked_utc=None,
        )
        with self._lock:
            rows = self._read_all_locked()
            if any(r["token"] == token for r in rows):
                raise ValueError(f"share token {token!r} already exists")
            rows.append(record.as_dict())
            self._write_all_locked(rows)
        return record

    def get_by_token(self, *, token: str) -> dict[str, Any] | None:
        for r in self._read_all():
            if r.get("token") == token:
                return r
        return None

    def list_for_owner(self, *, tenant_id: str, created_by: str) -> list[dict[str, Any]]:
        rows = [
            r for r in self._read_all()
            if r.get("tenant_id") == tenant_id and r.get("created_by") == created_by
        ]
        return sorted(rows, key=lambda r: r.get("created_utc") or "", reverse=True)

    def revoke(self, *, tenant_id: str, token: str, by_user_id: str) -> dict[str, Any] | None:
        with self._lock:
            rows = self._read_all_locked()
            for r in rows:
                if r.get("token") != token or r.get("tenant_id") != tenant_id:
                    continue
                if r.get("created_by") != by_user_id:
                    raise PermissionError("only the share owner can revoke it")
                if r.get("revoked_utc"):
                    return r
                r["revoked_utc"] = _iso(_now())
                self._write_all_locked(rows)
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


_SHARE_COLUMNS = (
    "token, tenant_id, created_by, title, snapshot, "
    "created_utc, expires_utc, revoked_utc"
)


class PostgresConversationShareRepository:
    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def create(self, *, token: str, tenant_id: str, created_by: str,
               title: str, snapshot: dict[str, Any],
               ttl_days: int = SHARE_TTL_DAYS) -> ShareRecord:
        if not token or not tenant_id or not created_by:
            raise ValueError("token, tenant_id, created_by are required")
        from psycopg import errors
        from psycopg.types.json import Json

        try:
            with self._conn(tenant_id) as conn:
                row = conn.execute(
                    f"INSERT INTO conversation_shares "
                    f"(token, tenant_id, created_by, title, snapshot, expires_utc) "
                    f"VALUES (%s, %s, %s, %s, %s, now() + (%s::int * interval '1 day')) "
                    f"RETURNING {_SHARE_COLUMNS}",
                    (token, tenant_id, created_by, title or "Untitled conversation",
                     Json(dict(snapshot or {})), ttl_days),
                ).fetchone()
        except errors.UniqueViolation as exc:
            raise ValueError(f"share token {token!r} already exists") from exc
        return _record_from_row(row)

    def get_by_token(self, *, token: str, tenant_id: str | None = None) -> dict[str, Any] | None:
        # Token is a global PK but RLS still scopes by tenant_id. Caller
        # passes their principal's tenant so the GUC matches; cross-tenant
        # lookups return None even if the token exists.
        scope = tenant_id or "*"
        with self._conn(scope) as conn:
            row = conn.execute(
                f"SELECT {_SHARE_COLUMNS} FROM conversation_shares WHERE token = %s",
                (token,),
            ).fetchone()
        return _serialize(row) if row else None

    def list_for_owner(self, *, tenant_id: str, created_by: str) -> list[dict[str, Any]]:
        with self._conn(tenant_id) as conn:
            rows = conn.execute(
                f"SELECT {_SHARE_COLUMNS} FROM conversation_shares "
                f"WHERE tenant_id = %s AND created_by = %s "
                f"ORDER BY created_utc DESC",
                (tenant_id, created_by),
            ).fetchall()
        return [_serialize(r) for r in rows]

    def revoke(self, *, tenant_id: str, token: str, by_user_id: str) -> dict[str, Any] | None:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"SELECT {_SHARE_COLUMNS} FROM conversation_shares "
                f"WHERE token = %s AND tenant_id = %s",
                (token, tenant_id),
            ).fetchone()
            if row is None:
                return None
            existing = _serialize(row)
            if existing["created_by"] != by_user_id:
                raise PermissionError("only the share owner can revoke it")
            if existing.get("revoked_utc"):
                return existing
            updated = conn.execute(
                f"UPDATE conversation_shares SET revoked_utc = now() "
                f"WHERE token = %s AND tenant_id = %s RETURNING {_SHARE_COLUMNS}",
                (token, tenant_id),
            ).fetchone()
        return _serialize(updated) if updated else None

    def _conn(self, tenant_id: str):
        from app.db import pg

        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in ("created_utc", "expires_utc", "revoked_utc"):
        value = out.get(key)
        if value is not None and not isinstance(value, str):
            out[key] = value.isoformat()
    out["snapshot"] = dict(out.get("snapshot") or {})
    return out


def _record_from_row(row: dict[str, Any]) -> ShareRecord:
    d = _serialize(row)
    return ShareRecord(
        token=d["token"], tenant_id=d["tenant_id"], created_by=d["created_by"],
        title=d["title"], snapshot=d["snapshot"],
        created_utc=d.get("created_utc", ""),
        expires_utc=d.get("expires_utc", ""),
        revoked_utc=d.get("revoked_utc"),
    )


def get_conversation_share_repository() -> (
    LocalJsonConversationShareRepository | PostgresConversationShareRepository
):
    settings = get_settings()
    if settings.persistence_backend == "local_json":
        return LocalJsonConversationShareRepository(settings.conversation_shares_store_path)
    if settings.persistence_backend == "postgres":
        return PostgresConversationShareRepository(settings.database_url)
    raise ValueError(f"unknown persistence backend {settings.persistence_backend}")
