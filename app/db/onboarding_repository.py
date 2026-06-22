"""Tenant-safe onboarding profile and organization invitation persistence."""
from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock
from typing import Any, cast
from uuid import uuid4

from app.config import get_settings


@dataclass
class OnboardingRecord:
    id: str
    user_id: str
    tenant_id: str
    account_type: str
    status: str = "in_progress"
    current_step: str = "account_type"
    answers: dict[str, Any] = field(default_factory=dict)
    completed_at: str | None = None
    created_at: str = ""
    updated_at: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class InvitationRecord:
    invitation_id: str
    tenant_id: str
    email: str
    role: str
    department: str | None
    message: str | None
    invite_token_hash: str
    status: str
    invited_by_user_id: str
    expires_at: str
    accepted_at: str | None = None
    created_at: str = ""
    updated_at: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class LocalJsonOnboardingRepository:
    def __init__(self, profiles_path: str | Path, invitations_path: str | Path) -> None:
        self.profiles_path = Path(profiles_path)
        self.invitations_path = Path(invitations_path)
        self._lock = Lock()

    def get_profile(self, *, user_id: str, tenant_id: str) -> dict[str, Any] | None:
        return next(
            (
                row for row in self._read(self.profiles_path)
                if row["user_id"] == user_id and row["tenant_id"] == tenant_id
            ),
            None,
        )

    def save_profile(
        self,
        *,
        user_id: str,
        tenant_id: str,
        account_type: str,
        current_step: str,
        answers: dict[str, Any],
        status: str = "in_progress",
    ) -> dict[str, Any]:
        if account_type not in {"individual", "company"}:
            raise ValueError("account_type must be individual or company")
        now = _now()
        with self._lock:
            rows = self._read_locked(self.profiles_path)
            existing = next(
                (
                    row for row in rows
                    if row["user_id"] == user_id and row["tenant_id"] == tenant_id
                ),
                None,
            )
            if existing:
                existing.update(
                    account_type=account_type,
                    current_step=current_step,
                    answers={**existing.get("answers", {}), **answers},
                    status=status,
                    updated_at=now,
                )
                if status == "completed":
                    existing["completed_at"] = existing.get("completed_at") or now
                record = existing
            else:
                record = OnboardingRecord(
                    id=str(uuid4()),
                    user_id=user_id,
                    tenant_id=tenant_id,
                    account_type=account_type,
                    current_step=current_step,
                    answers=dict(answers),
                    status=status,
                    completed_at=now if status == "completed" else None,
                    created_at=now,
                    updated_at=now,
                ).as_dict()
                rows.append(record)
            self._write_locked(self.profiles_path, rows)
            return dict(record)

    def create_invitation(
        self,
        *,
        tenant_id: str,
        email: str,
        role: str,
        department: str | None,
        message: str | None,
        invited_by_user_id: str,
        expiry_days: int,
    ) -> tuple[dict[str, Any], str]:
        raw_token = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc)
        record = InvitationRecord(
            invitation_id=str(uuid4()),
            tenant_id=tenant_id,
            email=email.strip().lower(),
            role=role,
            department=department,
            message=message,
            invite_token_hash=_token_hash(raw_token),
            status="pending",
            invited_by_user_id=invited_by_user_id,
            expires_at=(now + timedelta(days=expiry_days)).isoformat(),
            created_at=now.isoformat(),
            updated_at=now.isoformat(),
        ).as_dict()
        with self._lock:
            rows = self._read_locked(self.invitations_path)
            duplicate = next(
                (
                    row for row in rows
                    if row["tenant_id"] == tenant_id
                    and row["email"] == record["email"]
                    and row["status"] == "pending"
                ),
                None,
            )
            if duplicate:
                raise ValueError("a pending invitation already exists for this email")
            rows.append(record)
            self._write_locked(self.invitations_path, rows)
        return record, raw_token

    def list_invitations(self, *, tenant_id: str) -> list[dict[str, Any]]:
        return sorted(
            [row for row in self._read(self.invitations_path) if row["tenant_id"] == tenant_id],
            key=lambda row: row["created_at"],
            reverse=True,
        )

    def get_invitation(
        self, *, tenant_id: str, invitation_id: str
    ) -> dict[str, Any] | None:
        return next(
            (
                row for row in self._read(self.invitations_path)
                if row["tenant_id"] == tenant_id
                and row["invitation_id"] == invitation_id
            ),
            None,
        )

    def find_by_token(self, raw_token: str) -> dict[str, Any] | None:
        digest = _token_hash(raw_token)
        return next(
            (
                row for row in self._read(self.invitations_path)
                if secrets.compare_digest(row["invite_token_hash"], digest)
            ),
            None,
        )

    def update_invitation(
        self,
        *,
        tenant_id: str,
        invitation_id: str,
        changes: dict[str, Any],
    ) -> dict[str, Any]:
        with self._lock:
            rows = self._read_locked(self.invitations_path)
            for row in rows:
                if row["tenant_id"] == tenant_id and row["invitation_id"] == invitation_id:
                    row.update(changes)
                    row["updated_at"] = _now()
                    self._write_locked(self.invitations_path, rows)
                    return dict(row)
        raise KeyError("invitation not found")

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


class PostgresOnboardingRepository:
    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def get_profile(self, *, user_id: str, tenant_id: str) -> dict[str, Any] | None:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                "SELECT * FROM onboarding_profiles "
                "WHERE tenant_id = %s AND user_id = %s",
                (tenant_id, user_id),
            ).fetchone()
        return _serialize(row) if row else None

    def save_profile(
        self,
        *,
        user_id: str,
        tenant_id: str,
        account_type: str,
        current_step: str,
        answers: dict[str, Any],
        status: str = "in_progress",
    ) -> dict[str, Any]:
        from psycopg.types.json import Json

        completed = datetime.now(timezone.utc) if status == "completed" else None
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                """
                INSERT INTO onboarding_profiles
                    (id, user_id, tenant_id, account_type, status, current_step,
                     answers, completed_at)
                VALUES (gen_random_uuid()::text, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (tenant_id, user_id) DO UPDATE SET
                    account_type = EXCLUDED.account_type,
                    status = EXCLUDED.status,
                    current_step = EXCLUDED.current_step,
                    answers = onboarding_profiles.answers || EXCLUDED.answers,
                    completed_at = COALESCE(onboarding_profiles.completed_at, EXCLUDED.completed_at),
                    updated_at = now()
                RETURNING *
                """,
                (
                    user_id, tenant_id, account_type, status, current_step,
                    Json(answers), completed,
                ),
            ).fetchone()
        return _serialize(row)

    def create_invitation(self, **kwargs: Any) -> tuple[dict[str, Any], str]:
        raw_token = secrets.token_urlsafe(32)
        now = datetime.now(timezone.utc)
        from psycopg.types.json import Json  # noqa: F401

        with self._conn(kwargs["tenant_id"]) as conn:
            row = conn.execute(
                """
                INSERT INTO organization_invitations
                    (invitation_id, tenant_id, email, role, department, message,
                     invite_token_hash, status, invited_by_user_id, expires_at)
                VALUES (gen_random_uuid()::text, %s, lower(%s), %s, %s, %s, %s,
                        'pending', %s, %s)
                RETURNING *
                """,
                (
                    kwargs["tenant_id"], kwargs["email"], kwargs["role"],
                    kwargs.get("department"), kwargs.get("message"),
                    _token_hash(raw_token), kwargs["invited_by_user_id"],
                    now + timedelta(days=kwargs["expiry_days"]),
                ),
            ).fetchone()
        return _serialize(row), raw_token

    def list_invitations(self, *, tenant_id: str) -> list[dict[str, Any]]:
        with self._conn(tenant_id) as conn:
            rows = conn.execute(
                "SELECT * FROM organization_invitations "
                "WHERE tenant_id = %s ORDER BY created_at DESC",
                (tenant_id,),
            ).fetchall()
        return [_serialize(row) for row in rows]

    def get_invitation(
        self, *, tenant_id: str, invitation_id: str
    ) -> dict[str, Any] | None:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                "SELECT * FROM organization_invitations "
                "WHERE tenant_id = %s AND invitation_id = %s",
                (tenant_id, invitation_id),
            ).fetchone()
        return _serialize(row) if row else None

    def find_by_token(self, raw_token: str) -> dict[str, Any] | None:
        from app.db import pg

        with pg.tenant_connection("*", dsn=self.dsn, dict_rows=True) as conn:
            row = conn.execute(
                "SELECT * FROM organization_invitations WHERE invite_token_hash = %s",
                (_token_hash(raw_token),),
            ).fetchone()
        # dict_rows=True yields dict rows at runtime; mypy can't see that through the pool.
        return _serialize(cast("dict[str, Any]", row)) if row else None

    def update_invitation(
        self,
        *,
        tenant_id: str,
        invitation_id: str,
        changes: dict[str, Any],
    ) -> dict[str, Any]:
        allowed = {"role", "department", "status", "accepted_at", "expires_at"}
        invalid = set(changes) - allowed
        if invalid:
            raise ValueError(f"unsupported invitation fields: {sorted(invalid)}")
        assignments = [f"{key} = %s" for key in changes]
        params = [*changes.values(), tenant_id, invitation_id]
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"UPDATE organization_invitations SET {', '.join(assignments)}, "
                "updated_at = now() WHERE tenant_id = %s AND invitation_id = %s "
                "RETURNING *",
                params,
            ).fetchone()
        if row is None:
            raise KeyError("invitation not found")
        return _serialize(row)

    def _conn(self, tenant_id: str):
        from app.db import pg

        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def get_onboarding_repository() -> LocalJsonOnboardingRepository | PostgresOnboardingRepository:
    settings = get_settings()
    if settings.persistence_backend == "local_json":
        return LocalJsonOnboardingRepository(
            settings.onboarding_store_path,
            settings.invitations_store_path,
        )
    if settings.persistence_backend == "postgres":
        return PostgresOnboardingRepository(settings.database_url)
    raise ValueError(f"unknown persistence backend {settings.persistence_backend}")


def invitation_is_expired(record: dict[str, Any]) -> bool:
    return datetime.fromisoformat(record["expires_at"]) <= datetime.now(timezone.utc)


def _token_hash(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _serialize(row: dict[str, Any]) -> dict[str, Any]:
    result = dict(row)
    for key in ("completed_at", "expires_at", "accepted_at", "created_at", "updated_at"):
        value = result.get(key)
        if value is not None and not isinstance(value, str):
            result[key] = value.isoformat()
    return result
