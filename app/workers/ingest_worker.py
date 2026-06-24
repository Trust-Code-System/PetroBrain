"""
Async ingestion worker.

Pipeline per task:
    queued -> extracting (pull file from object store, extract text)
            -> embedding  (chunk + embed + upsert via app.rag.ingest)
            -> done | failed

The factory-style ``_get_*`` helpers exist so tests can monkeypatch the
embedder and vectorstore without spinning up Postgres/MinIO. Production
keeps the real `asyncpg` pool + `Embedder` wiring.
"""
from __future__ import annotations

import asyncio
import threading
from typing import Any

import structlog

from app.config import get_settings
from app.db.admin_document_repository import (
    LocalJsonAdminDocumentRepository,
    PostgresAdminDocumentRepository,
    get_admin_document_repository,
)
from app.rag.embeddings import Embedder
from app.rag.ingest import DocumentMetadata, ingest_extracted_text
from app.rag.vectorstore import VectorStore
from app.storage.object_store import get_object_store
from app.workers.celery_app import celery_app
from app.workers.extractors import extract_text
from app.workers.ingest_failures import safe_failure_reason

logger = structlog.get_logger(__name__)


@celery_app.task(name="petrobrain.ingest_document", bind=True, max_retries=0)
def ingest_document_task(self, tenant_id: str, ingest_id: str) -> dict[str, Any]:
    """
    Celery entrypoint. Runs the async pipeline in a dedicated thread so it
    works in both real worker processes (no event loop) and eager-test mode
    (called from inside FastAPI's running event loop).
    """
    return _run_sync(_run(tenant_id=tenant_id, ingest_id=ingest_id))


def _run_sync(coro) -> Any:
    box: dict[str, Any] = {}

    def runner() -> None:
        loop = asyncio.new_event_loop()
        try:
            box["value"] = loop.run_until_complete(coro)
        except BaseException as exc:  # noqa: BLE001 - re-raised on the caller thread
            box["error"] = exc
        finally:
            loop.close()

    thread = threading.Thread(target=runner, name="petrobrain-ingest")
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box["value"]


async def _run(*, tenant_id: str, ingest_id: str) -> dict[str, Any]:
    repo = _get_repository()
    record = repo.get(tenant_id=tenant_id, ingest_id=ingest_id)
    if record is None:
        return {"status": "failed", "ingest_id": ingest_id, "reason": "record not found"}

    try:
        repo.update_status(tenant_id=tenant_id, ingest_id=ingest_id, status="extracting")
        raw = _get_object_store().get(record["object_key"])
        text = extract_text(raw, record["filename"])
        if not text.strip():
            raise ValueError("extracted document text is empty")
    except Exception as exc:  # noqa: BLE001 - surface a SAFE reason on the record
        # Full detail to the server log only; the persisted/displayed reason is
        # sanitized so raw parser/temp-path errors never reach the admin UI.
        logger.warning(
            "ingest_extract_failed",
            tenant_id=tenant_id, ingest_id=ingest_id, error=str(exc),
            error_type=type(exc).__name__,
        )
        repo.update_status(
            tenant_id=tenant_id,
            ingest_id=ingest_id,
            status="failed",
            failure_reason=safe_failure_reason("extract", exc),
        )
        return {"status": "failed", "ingest_id": ingest_id, "reason": str(exc)}

    try:
        repo.update_status(tenant_id=tenant_id, ingest_id=ingest_id, status="embedding")
        metadata = DocumentMetadata(
            tenant_id=tenant_id,
            document_id=record["document_id"],
            title=record["title"],
            revision=record.get("revision", ""),
            jurisdiction=record.get("jurisdiction", ""),
            asset=record.get("asset"),
            document_type=record.get("document_type", "sop"),
        )
        store = await _get_vector_store()
        embedder = _get_embedder()
        chunk_count = await ingest_extracted_text(
            store, embedder, text=text, metadata=metadata
        )
    except Exception as exc:  # noqa: BLE001
        # An OpenAI 429 body ("You exceeded your current quota ...") or any other
        # provider error must NOT be persisted/shown verbatim - it leaks billing
        # state and our provider choice. Log it for ops; store a safe reason.
        logger.warning(
            "ingest_embed_failed",
            tenant_id=tenant_id, ingest_id=ingest_id, error=str(exc),
            error_type=type(exc).__name__,
        )
        repo.update_status(
            tenant_id=tenant_id,
            ingest_id=ingest_id,
            status="failed",
            failure_reason=safe_failure_reason("embed", exc),
        )
        return {"status": "failed", "ingest_id": ingest_id, "reason": str(exc)}

    repo.update_status(
        tenant_id=tenant_id,
        ingest_id=ingest_id,
        status="done",
        chunk_count=chunk_count,
    )
    return {"status": "done", "ingest_id": ingest_id, "chunk_count": chunk_count}


# ---- Factory hooks (monkeypatched in tests) ----------------------------------

def _get_repository() -> LocalJsonAdminDocumentRepository | PostgresAdminDocumentRepository:
    return get_admin_document_repository()


def _get_object_store():
    return get_object_store()


def _get_embedder() -> Embedder:
    return Embedder()


async def _get_vector_store() -> VectorStore:
    """
    Real wiring opens an asyncpg pool against PB_DATABASE_URL. Tests
    monkeypatch this hook to inject an in-process fake vectorstore.
    """
    import asyncpg

    settings = get_settings()
    url = settings.database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    pool = await asyncpg.create_pool(dsn=url, min_size=1, max_size=2)
    return VectorStore(pool)
