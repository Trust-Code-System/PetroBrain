"""
Per-turn chat feedback (thumbs up/down + optional reason).

Pluggable: LocalJson backend for dev/tests, Postgres backend for prod (migration
``011_feedback_events.sql``). Both expose the same surface so the API doesn't
care which one is wired. Tenant isolation is enforced in two places:

  1. Every query filters on ``tenant_id`` explicitly.
  2. The Postgres backend uses the ``petrobrain.tenant_id`` GUC + RLS policy.

Upsert keyed on (tenant_id, user_id, turn_id) so a user clicking thumbs-down
after a thumbs-up overwrites their previous rating instead of duplicating.

Strictly write-once-from-the-app-side then read-only for review - the orchestrator
DOES NOT auto-mutate feedback rows; if we ever build a re-ranker on top of this
table, it reads, it doesn't edit.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from app.config import get_settings


VALID_RATINGS = {"up", "down"}


@dataclass
class FeedbackRecord:
    id: str
    tenant_id: str
    user_id: str
    turn_id: str
    rating: str
    reason: str | None = None
    module: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    created_utc: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate(rating: str, reason: str | None) -> None:
    if rating not in VALID_RATINGS:
        raise ValueError(f"rating must be one of {sorted(VALID_RATINGS)}")
    if reason is not None and len(reason) > 2000:
        # Free-text reason capped - if a user needs more, they should file a
        # support ticket. The cap protects the audit log + admin UI.
        raise ValueError("reason is too long (max 2000 chars)")


class LocalJsonFeedbackRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def upsert(
        self, *, tenant_id: str, user_id: str, turn_id: str, rating: str,
        reason: str | None = None, module: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> FeedbackRecord:
        if not tenant_id or not user_id or not turn_id:
            raise ValueError("tenant_id, user_id, turn_id are required")
        _validate(rating, reason)
        now = _now()
        with self._lock:
            rows = self._read_all_locked()
            existing = next(
                (
                    r for r in rows
                    if r["tenant_id"] == tenant_id
                    and r["user_id"] == user_id
                    and r["turn_id"] == turn_id
                ),
                None,
            )
            if existing is not None:
                existing["rating"] = rating
                existing["reason"] = reason
                existing["module"] = module
                existing["metadata"] = metadata or {}
                record = FeedbackRecord(**existing)
                self._write_all_locked(rows)
                return record
            record = FeedbackRecord(
                id=str(uuid4()),
                tenant_id=tenant_id,
                user_id=user_id,
                turn_id=turn_id,
                rating=rating,
                reason=reason,
                module=module,
                metadata=metadata or {},
                created_utc=now,
            )
            rows.append(record.as_dict())
            self._write_all_locked(rows)
            return record

    def list_records(
        self, *, tenant_id: str, rating: str | None = None,
        limit: int = 200, offset: int = 0,
    ) -> list[dict[str, Any]]:
        rows = [r for r in self._read_all() if r["tenant_id"] == tenant_id]
        if rating is not None:
            rows = [r for r in rows if r.get("rating") == rating]
        rows.sort(key=lambda r: r.get("created_utc", ""), reverse=True)
        return rows[offset: offset + limit]

    def count(self, *, tenant_id: str, rating: str | None = None) -> int:
        rows = [r for r in self._read_all() if r["tenant_id"] == tenant_id]
        if rating is not None:
            rows = [r for r in rows if r.get("rating") == rating]
        return len(rows)

    def _read_all(self) -> list[dict[str, Any]]:
        with self._lock:
            return self._read_all_locked()

    def _read_all_locked(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        out: list[dict[str, Any]] = []
        with self.path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    def _write_all_locked(self, rows: list[dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, sort_keys=True) + "\n")


class PostgresFeedbackRepository:
    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def upsert(
        self, *, tenant_id: str, user_id: str, turn_id: str, rating: str,
        reason: str | None = None, module: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> FeedbackRecord:
        if not tenant_id or not user_id or not turn_id:
            raise ValueError("tenant_id, user_id, turn_id are required")
        _validate(rating, reason)
        from psycopg.types.json import Json
        with _pg_tenant(tenant_id, self.dsn) as conn:
            row = conn.execute(
                f"INSERT INTO feedback_events (id, tenant_id, user_id, turn_id, "
                f"rating, reason, module, metadata) "
                f"VALUES (COALESCE(%s, gen_random_uuid()::text), %s, %s, %s, %s, %s, %s, %s) "
                f"ON CONFLICT (tenant_id, user_id, turn_id) DO UPDATE SET "
                f"rating = EXCLUDED.rating, reason = EXCLUDED.reason, "
                f"module = EXCLUDED.module, metadata = EXCLUDED.metadata "
                f"RETURNING {_COLUMNS}",
                (None, tenant_id, user_id, turn_id, rating, reason, module,
                 Json(metadata or {})),
            ).fetchone()
        return _row_to_record(row)

    def list_records(
        self, *, tenant_id: str, rating: str | None = None,
        limit: int = 200, offset: int = 0,
    ) -> list[dict[str, Any]]:
        where = ["tenant_id = %s"]
        params: list[Any] = [tenant_id]
        if rating is not None:
            where.append("rating = %s")
            params.append(rating)
        params.extend([limit, offset])
        sql = (
            f"SELECT {_COLUMNS} FROM feedback_events "
            f"WHERE {' AND '.join(where)} "
            f"ORDER BY created_utc DESC LIMIT %s OFFSET %s"
        )
        with _pg_tenant(tenant_id, self.dsn) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_serialize_row(r) for r in rows]

    def count(self, *, tenant_id: str, rating: str | None = None) -> int:
        where = ["tenant_id = %s"]
        params: list[Any] = [tenant_id]
        if rating is not None:
            where.append("rating = %s")
            params.append(rating)
        with _pg_tenant(tenant_id, self.dsn) as conn:
            row = conn.execute(
                f"SELECT count(*) AS n FROM feedback_events WHERE {' AND '.join(where)}",
                params,
            ).fetchone()
        return int(row["n"])


_COLUMNS = "id, tenant_id, user_id, turn_id, rating, reason, module, metadata, created_utc"


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    if isinstance(out.get("created_utc"), datetime):
        out["created_utc"] = out["created_utc"].isoformat()
    return out


def _row_to_record(row: dict[str, Any]) -> FeedbackRecord:
    serialized = _serialize_row(row)
    return FeedbackRecord(**serialized)


def _pg_tenant(tenant_id: str, dsn: str | None):
    from app.db import pg

    return pg.tenant_connection(tenant_id, dsn=dsn, dict_rows=True)


def get_feedback_repository():
    settings = get_settings()
    if settings.persistence_backend == "postgres":
        return PostgresFeedbackRepository(settings.database_url)
    return LocalJsonFeedbackRepository(settings.feedback_store_path)
