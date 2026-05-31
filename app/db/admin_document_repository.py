"""
Persistence for async-uploaded admin documents with a status state machine.

State transitions:  queued -> extracting -> embedding -> done
                                                       \\-> failed
Each transition is appended to ``status_history`` with a UTC timestamp; the
status field always reflects the latest transition. Tenant isolation is
enforced on every read.
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


STATUSES = ("queued", "extracting", "embedding", "done", "failed")
TERMINAL = {"done", "failed"}


@dataclass
class AdminDocumentRecord:
    ingest_id: str
    tenant_id: str
    user_id: str
    document_id: str
    title: str
    revision: str
    jurisdiction: str
    asset: str | None
    effective_date: str | None
    document_type: str
    filename: str
    content_type: str
    size_bytes: int
    object_key: str
    status: str
    failure_reason: str | None = None
    chunk_count: int = 0
    status_history: list[dict[str, str]] = field(default_factory=list)
    created_utc: str = ""
    updated_utc: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class LocalJsonAdminDocumentRepository:
    """
    JSONL-backed repository with full-rewrite updates.

    Acceptable for Phase-1 dev/test volumes. The Postgres swap point is the
    ``admin_documents`` table referenced in A6 (audit log) - when that lands,
    swap the backend behind ``get_admin_document_repository()``.
    """

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = Lock()

    def create(
        self,
        *,
        tenant_id: str,
        user_id: str,
        metadata: dict[str, Any],
        filename: str,
        content_type: str,
        size_bytes: int,
        object_key: str,
        ingest_id: str | None = None,
    ) -> AdminDocumentRecord:
        now = _now()
        record = AdminDocumentRecord(
            ingest_id=ingest_id or str(uuid4()),
            tenant_id=tenant_id,
            user_id=user_id,
            document_id=metadata["document_id"],
            title=metadata["title"],
            revision=metadata.get("revision") or "",
            jurisdiction=metadata.get("jurisdiction") or "",
            asset=metadata.get("asset"),
            effective_date=str(metadata["effective_date"]) if metadata.get("effective_date") else None,
            document_type=metadata.get("document_type") or "sop",
            filename=filename,
            content_type=content_type,
            size_bytes=size_bytes,
            object_key=object_key,
            status="queued",
            status_history=[{"status": "queued", "at": now}],
            created_utc=now,
            updated_utc=now,
        )
        with self._lock:
            rows = self._read_all_locked()
            rows.append(record.as_dict())
            self._write_all_locked(rows)
        return record

    def update_status(
        self,
        *,
        tenant_id: str,
        ingest_id: str,
        status: str,
        failure_reason: str | None = None,
        chunk_count: int | None = None,
    ) -> dict[str, Any]:
        if status not in STATUSES:
            raise ValueError(f"unknown status: {status}")
        with self._lock:
            rows = self._read_all_locked()
            for row in rows:
                if row.get("tenant_id") == tenant_id and row.get("ingest_id") == ingest_id:
                    now = _now()
                    row["status"] = status
                    row["updated_utc"] = now
                    row.setdefault("status_history", []).append({"status": status, "at": now})
                    if failure_reason is not None:
                        row["failure_reason"] = failure_reason
                    if chunk_count is not None:
                        row["chunk_count"] = chunk_count
                    self._write_all_locked(rows)
                    return row
        raise KeyError(f"ingest {ingest_id} not found for tenant {tenant_id}")

    def get(self, *, tenant_id: str, ingest_id: str) -> dict[str, Any] | None:
        for row in self._read_all():
            if row.get("tenant_id") == tenant_id and row.get("ingest_id") == ingest_id:
                return row
        return None

    def list_records(self, *, tenant_id: str) -> list[dict[str, Any]]:
        rows = [_summary(r) for r in self._read_all() if r.get("tenant_id") == tenant_id]
        return sorted(rows, key=lambda r: r["created_utc"], reverse=True)

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


_ADMINDOC_COLUMNS = (
    "ingest_id, tenant_id, user_id, document_id, title, revision, jurisdiction, asset, "
    "effective_date, document_type, filename, content_type, size_bytes, object_key, "
    "status, failure_reason, chunk_count, status_history, created_utc, updated_utc"
)


class PostgresAdminDocumentRepository:
    """Postgres backend for admin_documents (migration 006), drop-in compatible
    with :class:`LocalJsonAdminDocumentRepository`. Tenant isolation via explicit
    WHERE filter + the petrobrain.tenant_id GUC (RLS backstop)."""

    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def create(self, *, tenant_id: str, user_id: str, metadata: dict[str, Any],
               filename: str, content_type: str, size_bytes: int, object_key: str,
               ingest_id: str | None = None) -> AdminDocumentRecord:
        from psycopg.types.json import Json

        now = datetime.now(timezone.utc)
        new_id = ingest_id or str(uuid4())
        history = [{"status": "queued", "at": now.isoformat()}]
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"INSERT INTO admin_documents (ingest_id, tenant_id, user_id, document_id, "
                f" title, revision, jurisdiction, asset, effective_date, document_type, "
                f" filename, content_type, size_bytes, object_key, status, status_history, "
                f" created_utc, updated_utc) "
                f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, "
                f" 'queued', %s, %s, %s) RETURNING {_ADMINDOC_COLUMNS}",
                (
                    new_id, tenant_id, user_id, metadata["document_id"], metadata["title"],
                    metadata.get("revision") or "", metadata.get("jurisdiction") or "",
                    metadata.get("asset"),
                    str(metadata["effective_date"]) if metadata.get("effective_date") else None,
                    metadata.get("document_type") or "sop", filename, content_type,
                    size_bytes, object_key, Json(history), now, now,
                ),
            ).fetchone()
        return _record_from_row(row)

    def update_status(self, *, tenant_id: str, ingest_id: str, status: str,
                      failure_reason: str | None = None,
                      chunk_count: int | None = None) -> dict[str, Any]:
        if status not in STATUSES:
            raise ValueError(f"unknown status: {status}")
        from psycopg.types.json import Json

        now = datetime.now(timezone.utc)
        sets = [
            "status = %s",
            "updated_utc = %s",
            "status_history = status_history || %s::jsonb",
        ]
        params: list[Any] = [status, now, Json([{"status": status, "at": now.isoformat()}])]
        if failure_reason is not None:
            sets.append("failure_reason = %s")
            params.append(failure_reason)
        if chunk_count is not None:
            sets.append("chunk_count = %s")
            params.append(chunk_count)
        params.extend([tenant_id, ingest_id])
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"UPDATE admin_documents SET {', '.join(sets)} "
                f"WHERE tenant_id = %s AND ingest_id = %s RETURNING {_ADMINDOC_COLUMNS}",
                params,
            ).fetchone()
        if row is None:
            raise KeyError(f"ingest {ingest_id} not found for tenant {tenant_id}")
        return _serialize_admindoc(row)

    def get(self, *, tenant_id: str, ingest_id: str) -> dict[str, Any] | None:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"SELECT {_ADMINDOC_COLUMNS} FROM admin_documents "
                f"WHERE tenant_id = %s AND ingest_id = %s",
                (tenant_id, ingest_id),
            ).fetchone()
        return _serialize_admindoc(row) if row else None

    def list_records(self, *, tenant_id: str) -> list[dict[str, Any]]:
        with self._conn(tenant_id) as conn:
            rows = conn.execute(
                f"SELECT {_ADMINDOC_COLUMNS} FROM admin_documents WHERE tenant_id = %s "
                f"ORDER BY created_utc DESC",
                (tenant_id,),
            ).fetchall()
        return [_summary(_serialize_admindoc(r)) for r in rows]

    def _conn(self, tenant_id: str):
        from app.db import pg

        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def _serialize_admindoc(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    for key in ("created_utc", "updated_utc"):
        value = out.get(key)
        if value is not None and not isinstance(value, str):
            out[key] = value.isoformat()
    out["status_history"] = list(out.get("status_history") or [])
    return out


def _record_from_row(row: dict[str, Any]) -> AdminDocumentRecord:
    data = _serialize_admindoc(row)
    return AdminDocumentRecord(
        ingest_id=data["ingest_id"], tenant_id=data["tenant_id"], user_id=data["user_id"],
        document_id=data["document_id"], title=data["title"], revision=data["revision"],
        jurisdiction=data["jurisdiction"], asset=data.get("asset"),
        effective_date=data.get("effective_date"), document_type=data["document_type"],
        filename=data["filename"], content_type=data["content_type"],
        size_bytes=data["size_bytes"], object_key=data["object_key"], status=data["status"],
        failure_reason=data.get("failure_reason"), chunk_count=data["chunk_count"],
        status_history=list(data.get("status_history") or []),
        created_utc=data["created_utc"], updated_utc=data["updated_utc"],
    )


def get_admin_document_repository() -> LocalJsonAdminDocumentRepository | PostgresAdminDocumentRepository:
    settings = get_settings()
    if settings.persistence_backend == "local_json":
        return LocalJsonAdminDocumentRepository(settings.admin_document_store_path)
    if settings.persistence_backend == "postgres":
        return PostgresAdminDocumentRepository(settings.database_url)
    raise ValueError(f"unknown persistence backend {settings.persistence_backend}")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _summary(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "ingest_id": record["ingest_id"],
        "document_id": record["document_id"],
        "title": record["title"],
        "revision": record.get("revision", ""),
        "jurisdiction": record.get("jurisdiction", ""),
        "asset": record.get("asset"),
        "document_type": record.get("document_type", "sop"),
        "filename": record["filename"],
        "content_type": record.get("content_type", ""),
        "size_bytes": record.get("size_bytes", 0),
        "status": record.get("status", "queued"),
        "chunk_count": record.get("chunk_count", 0),
        "failure_reason": record.get("failure_reason"),
        "created_utc": record["created_utc"],
        "updated_utc": record.get("updated_utc", record["created_utc"]),
    }
