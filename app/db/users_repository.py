"""
User registry (B8).

Production swap point is the ``users`` table from
``app/db/migrations/004_tenants_users.sql``. Phase-1 stores users in a
JSONL file with the same RLS contract: every read is tenant-scoped, the
``invite`` flow inserts ``status='invited'``, the activate / deactivate
flows mutate the status column, and ``set_role`` updates the role.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from app.api.deps import VALID_ROLES
from app.config import get_settings


STATUSES = ("invited", "active", "deactivated")


@dataclass
class UserRecord:
    id: str
    tenant_id: str
    email: str
    role: str
    status: str
    allowed_assets: list[str] = field(default_factory=list)
    invited_at_utc: str = ""
    last_active_utc: str | None = None
    created_utc: str = ""
    updated_utc: str = ""
    password_hash: str | None = None
    password_set_utc: str | None = None
    # Two-factor (TOTP). secret is base32; recovery codes are bcrypt hashes,
    # never plaintext. enabled flips true only once a code is proven.
    totp_secret: str | None = None
    totp_enabled: bool = False
    totp_recovery_codes: list[str] = field(default_factory=list)
    totp_enrolled_utc: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class LocalJsonUsersRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def invite(self, *, tenant_id: str, email: str, role: str,
               allowed_assets: list[str] | None = None,
               id: str | None = None) -> UserRecord:
        if not tenant_id or not email:
            raise ValueError("tenant_id and email are required")
        if role not in VALID_ROLES:
            raise ValueError(f"unknown role: {role}")
        with self._lock:
            rows = self._read_all_locked()
            if any(r["tenant_id"] == tenant_id and r["email"] == email for r in rows):
                raise ValueError(
                    f"user with email {email!r} already exists in tenant {tenant_id!r}"
                )
            now = _now()
            record = UserRecord(
                id=id or str(uuid4()),
                tenant_id=tenant_id,
                email=email,
                role=role,
                status="invited",
                allowed_assets=list(allowed_assets or []),
                invited_at_utc=now,
                last_active_utc=None,
                created_utc=now,
                updated_utc=now,
            )
            rows.append(record.as_dict())
            self._write_all_locked(rows)
            return record

    def list_records(self, *, tenant_id: str,
             status: str | None = None,
             role: str | None = None) -> list[dict[str, Any]]:
        if not tenant_id:
            raise ValueError("tenant_id is required")
        rows = [r for r in self._read_all() if r["tenant_id"] == tenant_id]
        if status is not None:
            rows = [r for r in rows if r["status"] == status]
        if role is not None:
            rows = [r for r in rows if r["role"] == role]
        rows.sort(key=lambda r: r["invited_at_utc"], reverse=True)
        return rows

    def get(self, *, tenant_id: str, user_id: str) -> dict[str, Any] | None:
        for row in self._read_all():
            if row["tenant_id"] == tenant_id and row["id"] == user_id:
                return row
        return None

    def get_by_email(self, *, tenant_id: str, email: str) -> dict[str, Any] | None:
        needle = email.strip().lower()
        for row in self._read_all():
            if row["tenant_id"] == tenant_id and row["email"].lower() == needle:
                return row
        return None

    def find_by_email_any_tenant(self, email: str) -> dict[str, Any] | None:
        """Locate a user by email across all tenants. Used by the Neon SSO
        path, which knows the email but not the tenant. Returns the first
        active match; collisions across tenants are a tenant-admin problem
        (the same email shouldn't sign in to two tenants at once)."""
        needle = email.strip().lower()
        for row in self._read_all():
            if row["email"].lower() == needle and row.get("status") == "active":
                return row
        return None

    def find_by_id_any_tenant(self, user_id: str) -> dict[str, Any] | None:
        """Locate an active user by id across all tenants. The Neon SSO path's
        primary mapping: a Neon Auth token carries the user id in ``sub`` (and
        may omit email), so a user is provisioned with ``id`` set to that Neon
        sub. Returns the first active match, or None."""
        needle = user_id.strip()
        for row in self._read_all():
            if row["id"] == needle and row.get("status") == "active":
                return row
        return None

    def signup(self, *, tenant_id: str, email: str, role: str,
               password_hash: str,
               allowed_assets: list[str] | None = None,
               id: str | None = None) -> UserRecord:
        """Self-serve signup: creates the user already active with a password.

        Distinct from :meth:`invite` (status='invited', no password). Raises
        ``ValueError`` if a row with the same lowercased email already exists.
        """
        if not tenant_id or not email:
            raise ValueError("tenant_id and email are required")
        if role not in VALID_ROLES:
            raise ValueError(f"unknown role: {role}")
        needle = email.strip().lower()
        with self._lock:
            rows = self._read_all_locked()
            if any(r["tenant_id"] == tenant_id and r["email"].lower() == needle for r in rows):
                raise ValueError(
                    f"user with email {email!r} already exists in tenant {tenant_id!r}"
                )
            now = _now()
            record = UserRecord(
                id=id or str(uuid4()),
                tenant_id=tenant_id,
                email=email.strip(),
                role=role,
                status="active",
                allowed_assets=list(allowed_assets or []),
                invited_at_utc=now,
                last_active_utc=now,
                created_utc=now,
                updated_utc=now,
                password_hash=password_hash,
                password_set_utc=now,
            )
            rows.append(record.as_dict())
            self._write_all_locked(rows)
            return record

    def set_password(self, *, tenant_id: str, user_id: str,
                     password_hash: str) -> dict[str, Any]:
        return self._update(
            tenant_id, user_id,
            password_hash=password_hash,
            password_set_utc=_now(),
        )

    def touch_last_active(self, *, tenant_id: str, user_id: str) -> dict[str, Any]:
        return self._update(tenant_id, user_id, last_active_utc=_now())

    def set_role(self, *, tenant_id: str, user_id: str,
                 role: str) -> dict[str, Any]:
        if role not in VALID_ROLES:
            raise ValueError(f"unknown role: {role}")
        return self._update(tenant_id, user_id, role=role)

    def set_status(self, *, tenant_id: str, user_id: str,
                   status: str) -> dict[str, Any]:
        if status not in STATUSES:
            raise ValueError(f"unknown status: {status}")
        return self._update(tenant_id, user_id, status=status)

    def set_allowed_assets(self, *, tenant_id: str, user_id: str,
                           allowed_assets: list[str]) -> dict[str, Any]:
        return self._update(tenant_id, user_id, allowed_assets=list(allowed_assets))

    def set_totp_pending(self, *, tenant_id: str, user_id: str,
                         secret: str) -> dict[str, Any]:
        """Store a not-yet-confirmed TOTP secret (enrollment in progress)."""
        return self._update(tenant_id, user_id, totp_secret=secret, totp_enabled=False)

    def enable_totp(self, *, tenant_id: str, user_id: str,
                    recovery_code_hashes: list[str]) -> dict[str, Any]:
        """Confirm enrollment: flip enabled on and store hashed recovery codes."""
        return self._update(
            tenant_id, user_id,
            totp_enabled=True,
            totp_recovery_codes=list(recovery_code_hashes),
            totp_enrolled_utc=_now(),
        )

    def replace_recovery_codes(self, *, tenant_id: str, user_id: str,
                               recovery_code_hashes: list[str]) -> dict[str, Any]:
        return self._update(
            tenant_id, user_id, totp_recovery_codes=list(recovery_code_hashes)
        )

    def disable_totp(self, *, tenant_id: str, user_id: str) -> dict[str, Any]:
        return self._update(
            tenant_id, user_id,
            totp_secret=None,
            totp_enabled=False,
            totp_recovery_codes=[],
            totp_enrolled_utc=None,
        )

    def _update(self, tenant_id: str, user_id: str, **changes: Any) -> dict[str, Any]:
        with self._lock:
            rows = self._read_all_locked()
            for row in rows:
                if row["tenant_id"] == tenant_id and row["id"] == user_id:
                    for key, value in changes.items():
                        row[key] = value
                    row["updated_utc"] = _now()
                    self._write_all_locked(rows)
                    return row
        raise KeyError(f"user {user_id!r} not found in tenant {tenant_id!r}")

    def count(self, *, tenant_id: str) -> int:
        return sum(1 for r in self._read_all() if r["tenant_id"] == tenant_id)

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


_USER_COLUMNS = (
    "id, tenant_id, email, role, status, allowed_assets, "
    "invited_at_utc, last_active_utc, created_utc, updated_utc, "
    "password_hash, password_set_utc, "
    "totp_secret, totp_enabled, totp_recovery_codes, totp_enrolled_utc"
)


class PostgresUsersRepository:
    """Postgres backend for the users table (migration 004), drop-in compatible
    with :class:`LocalJsonUsersRepository`.

    Tenant isolation is enforced twice: every statement carries an explicit
    ``tenant_id = %s`` filter, and each connection sets the ``petrobrain.tenant_id``
    GUC so the table's RLS policy is the backstop (see :mod:`app.db.pg`).
    Connection-per-call mirrors the stateless LocalJson repo; pooling is a later
    optimization.
    """

    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def invite(self, *, tenant_id: str, email: str, role: str,
               allowed_assets: list[str] | None = None,
               id: str | None = None) -> UserRecord:
        if not tenant_id or not email:
            raise ValueError("tenant_id and email are required")
        if role not in VALID_ROLES:
            raise ValueError(f"unknown role: {role}")
        from psycopg import errors
        from psycopg.types.json import Json

        try:
            with pg_tenant(tenant_id, self.dsn) as conn:
                row = conn.execute(
                    f"INSERT INTO users (id, tenant_id, email, role, status, allowed_assets) "
                    f"VALUES (COALESCE(%s, gen_random_uuid()::text), %s, %s, %s, 'invited', %s) "
                    f"RETURNING {_USER_COLUMNS}",
                    (id, tenant_id, email, role, Json(list(allowed_assets or []))),
                ).fetchone()
        except errors.UniqueViolation as exc:
            raise ValueError(
                f"user with email {email!r} already exists in tenant {tenant_id!r}"
            ) from exc
        return _record_from_row(row)

    def list_records(self, *, tenant_id: str,
                     status: str | None = None,
                     role: str | None = None) -> list[dict[str, Any]]:
        if not tenant_id:
            raise ValueError("tenant_id is required")
        clauses = ["tenant_id = %s"]
        params: list[Any] = [tenant_id]
        if status is not None:
            clauses.append("status = %s")
            params.append(status)
        if role is not None:
            clauses.append("role = %s")
            params.append(role)
        sql = (
            f"SELECT {_USER_COLUMNS} FROM users WHERE {' AND '.join(clauses)} "
            f"ORDER BY invited_at_utc DESC"
        )
        with pg_tenant(tenant_id, self.dsn) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_serialize_row(r) for r in rows]

    def get(self, *, tenant_id: str, user_id: str) -> dict[str, Any] | None:
        if not tenant_id:
            raise ValueError("tenant_id is required")
        with pg_tenant(tenant_id, self.dsn) as conn:
            row = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users WHERE tenant_id = %s AND id = %s",
                (tenant_id, user_id),
            ).fetchone()
        return _serialize_row(row) if row else None

    def get_by_email(self, *, tenant_id: str, email: str) -> dict[str, Any] | None:
        if not tenant_id:
            raise ValueError("tenant_id is required")
        with pg_tenant(tenant_id, self.dsn) as conn:
            row = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users "
                f"WHERE tenant_id = %s AND lower(email) = lower(%s)",
                (tenant_id, email.strip()),
            ).fetchone()
        return _serialize_row(row) if row else None

    def find_by_email_any_tenant(self, email: str) -> dict[str, Any] | None:
        """Cross-tenant email lookup for the Neon SSO path. Runs under the
        platform-admin GUC ('*') because the caller doesn't yet know the
        tenant - the result IS what supplies tenant_id to the Principal."""
        with pg_tenant(PLATFORM_ADMIN_TENANT, self.dsn) as conn:
            row = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users "
                f"WHERE lower(email) = lower(%s) AND status = 'active' "
                f"LIMIT 1",
                (email.strip(),),
            ).fetchone()
        return _serialize_row(row) if row else None

    def find_by_id_any_tenant(self, user_id: str) -> dict[str, Any] | None:
        """Cross-tenant id lookup for the Neon SSO path: ``users.id`` is set to
        the Neon Auth ``sub`` at provisioning time. Runs under the platform-admin
        GUC ('*') because the caller doesn't yet know the tenant - the result IS
        what supplies tenant_id to the Principal."""
        with pg_tenant(PLATFORM_ADMIN_TENANT, self.dsn) as conn:
            row = conn.execute(
                f"SELECT {_USER_COLUMNS} FROM users "
                f"WHERE id = %s AND status = 'active' "
                f"LIMIT 1",
                (user_id.strip(),),
            ).fetchone()
        return _serialize_row(row) if row else None

    def signup(self, *, tenant_id: str, email: str, role: str,
               password_hash: str,
               allowed_assets: list[str] | None = None,
               id: str | None = None) -> UserRecord:
        if not tenant_id or not email:
            raise ValueError("tenant_id and email are required")
        if role not in VALID_ROLES:
            raise ValueError(f"unknown role: {role}")
        from psycopg import errors
        from psycopg.types.json import Json

        try:
            with pg_tenant(tenant_id, self.dsn) as conn:
                row = conn.execute(
                    f"INSERT INTO users (id, tenant_id, email, role, status, allowed_assets, "
                    f"password_hash, password_set_utc, last_active_utc) "
                    f"VALUES (COALESCE(%s, gen_random_uuid()::text), %s, %s, %s, 'active', %s, "
                    f"%s, now(), now()) "
                    f"RETURNING {_USER_COLUMNS}",
                    (id, tenant_id, email.strip(), role, Json(list(allowed_assets or [])),
                     password_hash),
                ).fetchone()
        except errors.UniqueViolation as exc:
            raise ValueError(
                f"user with email {email!r} already exists in tenant {tenant_id!r}"
            ) from exc
        return _record_from_row(row)

    def set_password(self, *, tenant_id: str, user_id: str,
                     password_hash: str) -> dict[str, Any]:
        return self._update(
            tenant_id, user_id,
            password_hash=password_hash,
            password_set_utc=_now(),
        )

    def touch_last_active(self, *, tenant_id: str, user_id: str) -> dict[str, Any]:
        return self._update(tenant_id, user_id, last_active_utc=_now())

    def set_role(self, *, tenant_id: str, user_id: str, role: str) -> dict[str, Any]:
        if role not in VALID_ROLES:
            raise ValueError(f"unknown role: {role}")
        return self._update(tenant_id, user_id, role=role)

    def set_status(self, *, tenant_id: str, user_id: str, status: str) -> dict[str, Any]:
        if status not in STATUSES:
            raise ValueError(f"unknown status: {status}")
        return self._update(tenant_id, user_id, status=status)

    def set_allowed_assets(self, *, tenant_id: str, user_id: str,
                           allowed_assets: list[str]) -> dict[str, Any]:
        return self._update(tenant_id, user_id, allowed_assets=list(allowed_assets))

    def set_totp_pending(self, *, tenant_id: str, user_id: str,
                         secret: str) -> dict[str, Any]:
        return self._update(tenant_id, user_id, totp_secret=secret, totp_enabled=False)

    def enable_totp(self, *, tenant_id: str, user_id: str,
                    recovery_code_hashes: list[str]) -> dict[str, Any]:
        return self._update(
            tenant_id, user_id,
            totp_enabled=True,
            totp_recovery_codes=list(recovery_code_hashes),
            totp_enrolled_utc=_now(),
        )

    def replace_recovery_codes(self, *, tenant_id: str, user_id: str,
                               recovery_code_hashes: list[str]) -> dict[str, Any]:
        return self._update(
            tenant_id, user_id, totp_recovery_codes=list(recovery_code_hashes)
        )

    def disable_totp(self, *, tenant_id: str, user_id: str) -> dict[str, Any]:
        return self._update(
            tenant_id, user_id,
            totp_secret=None,
            totp_enabled=False,
            totp_recovery_codes=[],
            totp_enrolled_utc=None,
        )

    def _update(self, tenant_id: str, user_id: str, **changes: Any) -> dict[str, Any]:
        from psycopg.types.json import Json

        assignments = []
        params: list[Any] = []
        for key, value in changes.items():
            assignments.append(f"{key} = %s")
            params.append(
                Json(value) if key in ("allowed_assets", "totp_recovery_codes") else value
            )
        assignments.append("updated_utc = now()")
        params.extend([tenant_id, user_id])
        sql = (
            f"UPDATE users SET {', '.join(assignments)} "
            f"WHERE tenant_id = %s AND id = %s RETURNING {_USER_COLUMNS}"
        )
        with pg_tenant(tenant_id, self.dsn) as conn:
            row = conn.execute(sql, params).fetchone()
        if row is None:
            raise KeyError(f"user {user_id!r} not found in tenant {tenant_id!r}")
        return _serialize_row(row)

    def count(self, *, tenant_id: str) -> int:
        with pg_tenant(tenant_id, self.dsn) as conn:
            row = conn.execute(
                "SELECT count(*) AS n FROM users WHERE tenant_id = %s", (tenant_id,)
            ).fetchone()
        return int(row["n"])


def pg_tenant(tenant_id: str, dsn: str | None):
    """A dict-row connection with the tenant GUC set (see app.db.pg)."""
    from app.db import pg

    return pg.tenant_connection(tenant_id, dsn=dsn, dict_rows=True)


# Mirror of app.db.pg.PLATFORM_ADMIN_TENANT. Lifted here so this module doesn't
# pull psycopg at import time on the LocalJson path.
PLATFORM_ADMIN_TENANT = "*"


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Match LocalJson's dict shape: ISO-8601 strings for the timestamp columns."""
    out = dict(row)
    for key in (
        "invited_at_utc",
        "last_active_utc",
        "created_utc",
        "updated_utc",
        "password_set_utc",
        "totp_enrolled_utc",
    ):
        value = out.get(key)
        if value is not None and not isinstance(value, str):
            out[key] = value.isoformat()
    return out


def _record_from_row(row: dict[str, Any]) -> UserRecord:
    data = _serialize_row(row)
    return UserRecord(
        id=data["id"], tenant_id=data["tenant_id"], email=data["email"],
        role=data["role"], status=data["status"],
        allowed_assets=list(data.get("allowed_assets") or []),
        invited_at_utc=data.get("invited_at_utc", ""),
        last_active_utc=data.get("last_active_utc"),
        created_utc=data.get("created_utc", ""),
        updated_utc=data.get("updated_utc", ""),
        password_hash=data.get("password_hash"),
        password_set_utc=data.get("password_set_utc"),
        totp_secret=data.get("totp_secret"),
        totp_enabled=bool(data.get("totp_enabled")),
        totp_recovery_codes=list(data.get("totp_recovery_codes") or []),
        totp_enrolled_utc=data.get("totp_enrolled_utc"),
    )


def get_users_repository() -> LocalJsonUsersRepository | PostgresUsersRepository:
    settings = get_settings()
    if settings.persistence_backend == "local_json":
        return LocalJsonUsersRepository(settings.users_store_path)
    if settings.persistence_backend == "postgres":
        return PostgresUsersRepository(settings.database_url)
    raise ValueError(f"unknown persistence backend {settings.persistence_backend}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
