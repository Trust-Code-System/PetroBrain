"""Local document chunk persistence for Phase-1 ingestion UI."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from app.config import get_settings


@dataclass
class DocumentRecord:
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
    chunk_count: int
    chunks: list[dict[str, Any]]
    created_utc: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class LocalJsonDocumentRepository:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def save(self, *, tenant_id: str, user_id: str, request: dict[str, Any],
             chunks: list[dict[str, Any]]) -> DocumentRecord:
        record = DocumentRecord(
            ingest_id=str(uuid4()),
            tenant_id=tenant_id,
            user_id=user_id,
            document_id=request["document_id"],
            title=request["title"],
            revision=request.get("revision") or "",
            jurisdiction=request.get("jurisdiction") or "",
            asset=request.get("asset"),
            effective_date=str(request["effective_date"]) if request.get("effective_date") else None,
            document_type=request.get("document_type") or "sop",
            filename=request["filename"],
            chunk_count=len(chunks),
            chunks=chunks,
            created_utc=datetime.now(timezone.utc).isoformat(),
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record.as_dict(), sort_keys=True) + "\n")
        return record

    def list_records(self, *, tenant_id: str) -> list[dict[str, Any]]:
        rows = [
            _summary(r) for r in self._read_all()
            if r.get("tenant_id") == tenant_id
        ]
        return sorted(rows, key=lambda r: r["created_utc"], reverse=True)

    def get(self, *, tenant_id: str, ingest_id: str) -> dict[str, Any] | None:
        for record in self._read_all():
            if record.get("tenant_id") == tenant_id and record.get("ingest_id") == ingest_id:
                return record
        return None

    def snapshot(self, *, tenant_id: str, since: str | None = None) -> list[dict[str, Any]]:
        """Full records (with chunks) created after ``since`` (ISO-8601), oldest
        first - for the field app's incremental offline SOP cache."""
        rows = [r for r in self._read_all() if r.get("tenant_id") == tenant_id]
        if since:
            rows = [r for r in rows if r.get("created_utc", "") > since]
        return sorted(rows, key=lambda r: r.get("created_utc", ""))

    def _read_all(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines() if line.strip()]


_DOC_COLUMNS = (
    "ingest_id, tenant_id, user_id, document_id, title, revision, jurisdiction, "
    "asset, effective_date, document_type, filename, chunk_count, chunks, created_utc"
)


class PostgresDocumentRepository:
    """Postgres backend for the documents table (migration 005), drop-in
    compatible with :class:`LocalJsonDocumentRepository`. Tenant isolation via
    explicit WHERE filter + the petrobrain.tenant_id GUC (RLS backstop)."""

    def __init__(self, dsn: str | None = None) -> None:
        self.dsn = dsn

    def save(self, *, tenant_id: str, user_id: str, request: dict[str, Any],
             chunks: list[dict[str, Any]]) -> DocumentRecord:
        from psycopg.types.json import Json

        ingest_id = str(uuid4())
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"INSERT INTO documents (ingest_id, tenant_id, user_id, document_id, title, "
                f" revision, jurisdiction, asset, effective_date, document_type, filename, "
                f" chunk_count, chunks) "
                f"VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
                f"RETURNING {_DOC_COLUMNS}",
                (
                    ingest_id, tenant_id, user_id, request["document_id"], request["title"],
                    request.get("revision") or "", request.get("jurisdiction") or "",
                    request.get("asset"),
                    str(request["effective_date"]) if request.get("effective_date") else None,
                    request.get("document_type") or "sop", request["filename"],
                    len(chunks), Json(list(chunks)),
                ),
            ).fetchone()
        return _record_from_row(row)

    def list_records(self, *, tenant_id: str) -> list[dict[str, Any]]:
        with self._conn(tenant_id) as conn:
            rows = conn.execute(
                f"SELECT {_DOC_COLUMNS} FROM documents WHERE tenant_id = %s "
                f"ORDER BY created_utc DESC",
                (tenant_id,),
            ).fetchall()
        return [_summary(_serialize_doc(r)) for r in rows]

    def get(self, *, tenant_id: str, ingest_id: str) -> dict[str, Any] | None:
        with self._conn(tenant_id) as conn:
            row = conn.execute(
                f"SELECT {_DOC_COLUMNS} FROM documents WHERE tenant_id = %s AND ingest_id = %s",
                (tenant_id, ingest_id),
            ).fetchone()
        return _serialize_doc(row) if row else None

    def snapshot(self, *, tenant_id: str, since: str | None = None) -> list[dict[str, Any]]:
        clauses = ["tenant_id = %s"]
        params: list[Any] = [tenant_id]
        if since:
            clauses.append("created_utc > %s")  # %s (ISO text) cast to timestamptz by PG
            params.append(since)
        sql = (
            f"SELECT {_DOC_COLUMNS} FROM documents WHERE {' AND '.join(clauses)} "
            f"ORDER BY created_utc ASC"
        )
        with self._conn(tenant_id) as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_serialize_doc(r) for r in rows]

    def _conn(self, tenant_id: str):
        from app.db import pg

        return pg.tenant_connection(tenant_id, dsn=self.dsn, dict_rows=True)


def _serialize_doc(row: dict[str, Any]) -> dict[str, Any]:
    out = dict(row)
    created = out.get("created_utc")
    if created is not None and not isinstance(created, str):
        out["created_utc"] = created.isoformat()
    out["chunks"] = list(out.get("chunks") or [])
    return out


def _record_from_row(row: dict[str, Any]) -> DocumentRecord:
    data = _serialize_doc(row)
    return DocumentRecord(
        ingest_id=data["ingest_id"], tenant_id=data["tenant_id"], user_id=data["user_id"],
        document_id=data["document_id"], title=data["title"], revision=data["revision"],
        jurisdiction=data["jurisdiction"], asset=data.get("asset"),
        effective_date=data.get("effective_date"), document_type=data["document_type"],
        filename=data["filename"], chunk_count=data["chunk_count"],
        chunks=list(data.get("chunks") or []), created_utc=data["created_utc"],
    )


def get_document_repository() -> LocalJsonDocumentRepository | PostgresDocumentRepository:
    settings = get_settings()
    if settings.persistence_backend == "local_json":
        return LocalJsonDocumentRepository(settings.document_store_path)
    if settings.persistence_backend == "postgres":
        return PostgresDocumentRepository(settings.database_url)
    raise ValueError(f"unknown persistence backend {settings.persistence_backend}")


def _summary(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "ingest_id": record["ingest_id"],
        "document_id": record["document_id"],
        "title": record["title"],
        "revision": record["revision"],
        "jurisdiction": record["jurisdiction"],
        "asset": record["asset"],
        "document_type": record["document_type"],
        "filename": record["filename"],
        "chunk_count": record["chunk_count"],
        "created_utc": record["created_utc"],
    }
