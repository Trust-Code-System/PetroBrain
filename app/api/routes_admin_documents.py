"""
Admin document upload + status (A5).

POST /admin/documents     multipart upload (file + metadata JSON), role=admin or platform_admin
GET  /admin/documents     list ingest jobs for the principal's tenant
GET  /admin/documents/{ingest_id}  status detail

The route persists the raw file to object storage, creates a queued record,
and enqueues the ingestion task. The Celery worker handles extract -> chunk
-> embed -> upsert and walks the status state machine.
"""
from __future__ import annotations

import json
import logging
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import ValidationError

from app.api.deps import Principal, require_asset_access, require_role
from app.core.audit import AuditEvent, get_audit_logger
from app.config import get_settings
from app.db.admin_document_repository import get_admin_document_repository
from app.models.schemas import AdminDocumentMetadata
from app.security.malware import MalwareDetected, MalwareScanUnavailable, scan_bytes
from app.storage.object_store import get_object_store, object_key_for
from app.workers.extractors import supported_extension
from app.workers.ingest_worker import ingest_document_task


router = APIRouter(prefix="/admin/documents", tags=["admin", "documents"])
audit_logger = get_audit_logger()
logger = logging.getLogger("petrobrain.admin_documents")

MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB; tighten per tenant later
_admin_only = require_role("admin", "platform_admin")


@router.post("")
async def upload_document(
    file: UploadFile = File(...),
    metadata: str = Form(..., description="JSON object with admin document metadata"),
    who: Principal = Depends(_admin_only),
):
    settings = get_settings()
    # Demo deployments use in-memory object storage; persisting an upload here
    # would silently lose the document on the next restart. Refuse with a
    # clear error rather than performing a write that won't survive.
    if settings.object_store_backend == "memory":
        raise HTTPException(
            status_code=410,
            detail=(
                "uploads are disabled on this demo instance "
                "(object storage is in-memory; documents would not persist)"
            ),
        )
    parsed = _parse_metadata(metadata)
    require_asset_access(who, parsed.asset)
    filename = (file.filename or "").strip()
    if not filename:
        raise HTTPException(status_code=422, detail="uploaded file requires a filename")
    if not supported_extension(filename):
        raise HTTPException(
            status_code=422,
            detail="unsupported document extension (allowed: .txt .md .markdown .pdf .docx)",
        )

    body = await file.read()
    if not body:
        raise HTTPException(status_code=422, detail="uploaded file is empty")
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="uploaded file exceeds 50 MiB limit")
    _validate_file_signature(filename, body)
    _scan_upload(filename, body, who)

    repo = _repository()
    object_store = _object_store()

    metadata_dict = parsed.model_dump(mode="json")
    ingest_id = str(uuid4())
    key = object_key_for(tenant_id=who.tenant_id, ingest_id=ingest_id, filename=filename)
    try:
        object_store.put(key, body, content_type=file.content_type)
    except Exception as exc:  # noqa: BLE001
        _audit_admin_doc(
            "admin_document_upload_error", who, ingest_id, metadata_dict, filename,
            error={"status_code": 500, "detail": str(exc)},
        )
        raise HTTPException(status_code=500, detail="object storage write failed") from exc

    record = repo.create(
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        metadata=metadata_dict,
        filename=filename,
        content_type=file.content_type or "application/octet-stream",
        size_bytes=len(body),
        object_key=key,
        ingest_id=ingest_id,
    )

    try:
        _dispatch_ingest(repo, tenant_id=who.tenant_id, ingest_id=record.ingest_id)
    except Exception as exc:  # noqa: BLE001 - broker/dispatch failure
        _audit_admin_doc(
            "admin_document_upload_error", who, record.ingest_id, metadata_dict, filename,
            error={"status_code": 503, "detail": f"dispatch: {exc}"},
        )
        raise HTTPException(
            status_code=503,
            detail="ingestion dispatch failed; document marked failed (retry once the worker/broker is reachable)",
        ) from exc

    _audit_admin_doc(
        "admin_document_upload",
        who,
        record.ingest_id,
        metadata_dict,
        filename,
        response={"ingest_id": record.ingest_id, "status": "queued"},
    )
    return _to_status(repo.get(tenant_id=who.tenant_id, ingest_id=record.ingest_id))


@router.get("")
async def list_documents(who: Principal = Depends(_admin_only)):
    return {"documents": _repository().list_records(tenant_id=who.tenant_id)}


@router.get("/{ingest_id}")
async def get_document(ingest_id: str, who: Principal = Depends(_admin_only)):
    record = _repository().get(tenant_id=who.tenant_id, ingest_id=ingest_id)
    if record is None:
        raise HTTPException(status_code=404, detail="admin document ingest not found")
    return _to_status(record)


# Statuses that can be re-dispatched. "extracting"/"embedding" are in-flight in
# async mode (don't double-run); "done" is already indexed (re-upload to refresh).
_REQUEUEABLE = {"queued", "failed"}


@router.post("/requeue-stuck")
async def requeue_stuck_documents(who: Principal = Depends(_admin_only)):
    """Re-dispatch every requeueable (queued/failed) ingest for the tenant.

    Repairs documents stranded by an earlier broker/worker misconfiguration. In
    eager mode each runs the extract->embed pipeline inline, so this request may
    take a while for large backlogs.
    """
    repo = _repository()
    targets = [
        r for r in repo.list_records(tenant_id=who.tenant_id)
        if r.get("status") in _REQUEUEABLE
    ]
    results: list[dict[str, Any]] = []
    for r in targets:
        ingest_id = r["ingest_id"]
        try:
            _requeue_one(repo, who, ingest_id)
            outcome = repo.get(tenant_id=who.tenant_id, ingest_id=ingest_id)
            results.append({"ingest_id": ingest_id, "status": outcome["status"]})
        except Exception as exc:  # noqa: BLE001 - report per-doc, keep going
            results.append({"ingest_id": ingest_id, "status": "failed", "detail": f"dispatch: {exc}"})
    return {"requeued": len(targets), "results": results}


@router.post("/{ingest_id}/requeue")
async def requeue_document(ingest_id: str, who: Principal = Depends(_admin_only)):
    """Re-dispatch a single stuck ingest (queued or failed)."""
    repo = _repository()
    record = repo.get(tenant_id=who.tenant_id, ingest_id=ingest_id)
    if record is None:
        raise HTTPException(status_code=404, detail="admin document ingest not found")
    status = record.get("status")
    if status not in _REQUEUEABLE:
        raise HTTPException(
            status_code=409,
            detail=f"cannot requeue a document in '{status}' state (only queued/failed)",
        )
    try:
        _requeue_one(repo, who, ingest_id)
    except Exception as exc:  # noqa: BLE001 - broker/dispatch failure
        _audit_admin_doc(
            "admin_document_requeue_error", who, ingest_id,
            _metadata_from_record(record), record["filename"],
            error={"status_code": 503, "detail": f"dispatch: {exc}"},
        )
        raise HTTPException(
            status_code=503,
            detail="ingestion dispatch failed; document marked failed (retry once the worker/broker is reachable)",
        ) from exc
    return _to_status(repo.get(tenant_id=who.tenant_id, ingest_id=ingest_id))


# ---- helpers -----------------------------------------------------------------

def _dispatch_ingest(repo, *, tenant_id: str, ingest_id: str) -> None:
    """Enqueue the ingestion task. In eager mode this runs the pipeline inline.

    If async dispatch raises (an empty/scheme-less/unreachable broker), don't
    strand the document: run the task inline via ``.apply()`` (which needs no
    broker) so it still gets processed. Only if that inline run also fails do we
    mark the record ``failed`` and re-raise for the caller to translate to a 503.
    """
    try:
        ingest_document_task.delay(tenant_id, ingest_id)
        return
    except Exception as exc:  # noqa: BLE001 - broker publish failed; fall back to inline
        logger.warning(
            "celery dispatch failed for ingest %s (%s); running ingestion inline",
            ingest_id, exc,
        )

    try:
        ingest_document_task.apply(args=(tenant_id, ingest_id), throw=False)
    except Exception as exc:  # noqa: BLE001 - inline execution itself failed
        try:
            repo.update_status(
                tenant_id=tenant_id,
                ingest_id=ingest_id,
                status="failed",
                failure_reason=f"dispatch: {exc}",
            )
        except Exception:  # noqa: BLE001 - never mask the original failure
            pass
        raise


def _requeue_one(repo, who: Principal, ingest_id: str) -> None:
    # Reset to queued so the status history records the fresh run, then dispatch.
    repo.update_status(tenant_id=who.tenant_id, ingest_id=ingest_id, status="queued")
    _dispatch_ingest(repo, tenant_id=who.tenant_id, ingest_id=ingest_id)
    record = repo.get(tenant_id=who.tenant_id, ingest_id=ingest_id)
    _audit_admin_doc(
        "admin_document_requeue", who, ingest_id,
        _metadata_from_record(record), record["filename"],
        response={"ingest_id": ingest_id, "status": record["status"]},
    )


def _metadata_from_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "document_id": record.get("document_id"),
        "title": record.get("title"),
        "revision": record.get("revision"),
        "asset": record.get("asset"),
    }

def _repository():
    return get_admin_document_repository()


def _object_store():
    return get_object_store()


def _parse_metadata(raw: str) -> AdminDocumentMetadata:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"metadata is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail="metadata must be a JSON object")
    try:
        return AdminDocumentMetadata(**payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc


def _validate_file_signature(filename: str, body: bytes) -> None:
    lower = filename.lower()
    if lower.endswith(".pdf") and not body.startswith(b"%PDF-"):
        raise HTTPException(status_code=422, detail="uploaded PDF has an invalid file signature")
    if lower.endswith(".docx") and not body.startswith(b"PK\x03\x04"):
        raise HTTPException(status_code=422, detail="uploaded DOCX has an invalid file signature")
    if lower.endswith((".txt", ".md", ".markdown")) and b"\x00" in body[:4096]:
        raise HTTPException(status_code=422, detail="uploaded text file appears to be binary")


def _scan_upload(filename: str, body: bytes, who: Principal) -> None:
    settings = get_settings()
    # H8: a non-prod deploy that accepts uploads with the scanner disabled is
    # the prospect-demo malware vector we saw in the audit. The fail-closed
    # default outside prod was False; here we promote it to True unconditionally
    # whenever the scanner is *enabled* but unreachable, so a half-configured
    # staging never accepts unscanned bytes.
    try:
        scan_bytes(filename, body, settings)
    except MalwareDetected as exc:
        raise HTTPException(status_code=422, detail=f"malware detected: {exc}") from exc
    except MalwareScanUnavailable as exc:
        if settings.malware_scan_enabled or settings.malware_scan_fail_closed:
            raise HTTPException(status_code=503, detail="malware scanner unavailable") from exc
        audit_logger.write(AuditEvent(
            event_type="admin_document_malware_scan_unavailable",
            tenant_id=who.tenant_id,
            user_id=who.user_id,
            role=who.role,
            route="/admin/documents",
            request={"filename": filename},
            error={"status_code": 503, "detail": str(exc)},
            flags=["malware_scan_unavailable"],
        ))


def _to_status(record: dict[str, Any]) -> dict[str, Any]:
    status = record["status"]
    return {
        "ingest_id": record["ingest_id"],
        "tenant_id": record["tenant_id"],
        "document_id": record["document_id"],
        "title": record["title"],
        "filename": record["filename"],
        "status": status,
        "chunk_count": record.get("chunk_count", 0),
        "failure_reason": record.get("failure_reason") if status == "failed" else None,
        "created_utc": record["created_utc"],
        "updated_utc": record.get("updated_utc", record["created_utc"]),
    }


def _audit_admin_doc(
    event_type: str,
    who: Principal,
    ingest_id: str,
    metadata: dict[str, Any],
    filename: str,
    response: dict[str, Any] | None = None,
    error: dict[str, Any] | None = None,
) -> None:
    audit_logger.write(AuditEvent(
        event_type=event_type,
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/admin/documents",
        request={**metadata, "filename": filename},
        response=response,
        error=error,
        flags=["upload_error"] if error else [],
        metadata={
            "ingest_id": ingest_id,
            "document_id": metadata.get("document_id"),
            "title": metadata.get("title"),
            "revision": metadata.get("revision"),
            "asset": metadata.get("asset"),
            "filename": filename,
        },
    ))
