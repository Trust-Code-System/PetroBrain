"""
A5 end-to-end test: multipart admin upload -> object store -> eager Celery
worker -> repository state machine -> done with chunk_count.

The test avoids all external services:
- In-memory object store (no MinIO required).
- Fake embedder (no OpenAI call).
- Fake vectorstore (no Postgres/pgvector required).
- Celery configured with task_always_eager so the task runs in-process.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api import deps, routes_admin_documents
from app.db.admin_document_repository import LocalJsonAdminDocumentRepository
from app.main import app
from app.storage.object_store import InMemoryObjectStore
from app.workers import ingest_worker
from app.workers.celery_app import celery_app
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


class _FakeEmbedder:
    """Deterministic embedder so no network call is made."""

    async def embed(self, texts):
        return [[float(len(t) % 7), 0.1, 0.2, 0.3] for t in texts]


class _FakeVectorStore:
    """In-memory vectorstore the worker upserts into."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    async def upsert(self, rows):
        self.rows.extend(rows)
        return len(rows)


@pytest.fixture
def admin_repo(tmp_path):
    return LocalJsonAdminDocumentRepository(tmp_path / "admin_documents.jsonl")


@pytest.fixture
def memory_store():
    return InMemoryObjectStore()


@pytest.fixture
def fake_vectorstore():
    return _FakeVectorStore()


@pytest.fixture(autouse=True)
def wire(monkeypatch, admin_repo, memory_store, fake_vectorstore):
    # JWT verification keys/issuer/audience match the test mint helper.
    monkeypatch.setattr(deps, "get_settings", jwt_settings)

    # The upload rate limiter (10/min) is an in-process counter shared across
    # the TestClient; clear it per test so the suite's many uploads don't trip
    # 429s on each other.
    from app.core import http_hardening
    http_hardening.clear_rate_limits()

    # Route + worker share the same in-process repo + object store.
    monkeypatch.setattr(routes_admin_documents, "_repository", lambda: admin_repo)
    monkeypatch.setattr(routes_admin_documents, "_object_store", lambda: memory_store)
    monkeypatch.setattr(routes_admin_documents, "_scan_upload", lambda filename, body, who: None)
    monkeypatch.setattr(ingest_worker, "_get_repository", lambda: admin_repo)
    monkeypatch.setattr(ingest_worker, "_get_object_store", lambda: memory_store)
    monkeypatch.setattr(ingest_worker, "_get_embedder", lambda: _FakeEmbedder())

    async def _vs():
        return fake_vectorstore

    monkeypatch.setattr(ingest_worker, "_get_vector_store", _vs)

    # Run Celery tasks in-process so the harness needs no broker.
    prev_eager = celery_app.conf.task_always_eager
    prev_propagates = celery_app.conf.task_eager_propagates
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True
    try:
        yield
    finally:
        celery_app.conf.task_always_eager = prev_eager
        celery_app.conf.task_eager_propagates = prev_propagates


def _admin_headers(**overrides):
    return auth_headers(
        tenant_id=overrides.pop("tenant_id", "tenant-a"),
        user_id=overrides.pop("user_id", "alice"),
        role=overrides.pop("role", "admin"),
        allowed_assets=overrides.pop("allowed_assets", ["Asset-A"]),
        **overrides,
    )


def _payload(**overrides):
    base = {
        "document_id": "SOP-KICK-001",
        "title": "Kick Detection SOP",
        "revision": "Rev 1",
        "jurisdiction": "Nigeria",
        "asset": "Asset-A",
        "document_type": "sop",
    }
    base.update(overrides)
    return base


_KICK_MD = (
    "# 1 Purpose\n"
    "Detect kicks early and route live well-control events to the competent person.\n\n"
    "## 2.1 Flow check\n"
    "If the flow check is positive, follow the rig shut-in procedure and record SIDPP, SICP and pit gain.\n"
)


def test_admin_upload_txt_runs_full_pipeline(admin_repo, memory_store, fake_vectorstore):
    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload())},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    ingest_id = body["ingest_id"]

    # Eager Celery should have completed the task before the POST returns.
    detail = client.get(f"/admin/documents/{ingest_id}", headers=_admin_headers()).json()
    assert detail["status"] == "done", detail
    assert detail["chunk_count"] >= 2
    assert detail["failure_reason"] is None

    # Status history walked the full machine.
    record = admin_repo.get(tenant_id="tenant-a", ingest_id=ingest_id)
    statuses = [step["status"] for step in record["status_history"]]
    assert statuses == ["queued", "extracting", "embedding", "done"]

    # Raw bytes landed in the object store under the tenant-scoped key.
    assert record["object_key"].startswith("tenants/tenant-a/documents/")
    assert memory_store.get(record["object_key"]).decode("utf-8").startswith("# 1 Purpose")

    # Vectorstore received chunked rows with tenant + document metadata.
    assert fake_vectorstore.rows, "expected chunks to be upserted into the vectorstore"
    first = fake_vectorstore.rows[0]
    assert first["tenant_id"] == "tenant-a"
    assert first["document_id"] == "SOP-KICK-001"
    assert "embedding" in first and isinstance(first["embedding"], list)


def test_admin_upload_requires_admin_role():
    r = client.post(
        "/admin/documents",
        headers=auth_headers(role="engineer", allowed_assets=["Asset-A"]),
        data={"metadata": json.dumps(_payload())},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    assert r.status_code == 403


def test_admin_upload_enforces_asset_scope():
    r = client.post(
        "/admin/documents",
        headers=_admin_headers(allowed_assets=["Asset-B"]),
        data={"metadata": json.dumps(_payload(asset="Asset-A"))},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    assert r.status_code == 403
    assert r.json()["detail"] == "asset not allowed for principal"


def test_admin_upload_rejects_unsupported_extension():
    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload())},
        files={"file": ("data.bin", b"\x00\x01\x02", "application/octet-stream")},
    )
    assert r.status_code == 422
    assert "unsupported" in r.json()["detail"].lower()


def test_admin_upload_rejects_spoofed_pdf_signature():
    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload())},
        files={"file": ("kick.pdf", b"not really a pdf", "application/pdf")},
    )
    assert r.status_code == 422
    assert "signature" in r.json()["detail"].lower()


def test_admin_upload_rejects_binary_text_file():
    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload())},
        files={"file": ("kick.md", b"# ok\n\x00binary", "text/markdown")},
    )
    assert r.status_code == 422
    assert "binary" in r.json()["detail"].lower()


def test_admin_upload_rejects_malware(monkeypatch, memory_store):
    def _infected(filename, body, who):
        raise HTTPException(status_code=422, detail="malware detected: Eicar-Test-Signature")

    monkeypatch.setattr(routes_admin_documents, "_scan_upload", _infected)

    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload())},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )

    assert r.status_code == 422
    assert "malware detected" in r.json()["detail"]
    assert memory_store._items == {}


def test_admin_upload_rejects_empty_file():
    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload())},
        files={"file": ("kick.md", b"", "text/markdown")},
    )
    assert r.status_code == 422
    assert r.json()["detail"] == "uploaded file is empty"


def test_admin_upload_rejects_invalid_metadata_json():
    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": "{not-json"},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    assert r.status_code == 422
    assert "JSON" in r.json()["detail"]


def test_admin_list_is_tenant_isolated(admin_repo):
    # Tenant A uploads.
    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload())},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    assert r.status_code == 200

    # Tenant B cannot see it.
    b_list = client.get(
        "/admin/documents",
        headers=_admin_headers(tenant_id="tenant-b", user_id="bob",
                               allowed_assets=["*"]),
    )
    assert b_list.status_code == 200
    assert b_list.json()["documents"] == []

    a_list = client.get("/admin/documents", headers=_admin_headers())
    assert a_list.status_code == 200
    assert len(a_list.json()["documents"]) == 1


def test_upload_runs_inline_when_async_dispatch_fails(monkeypatch, admin_repo, memory_store):
    # Broken broker: .delay() raises. The route must fall back to running the
    # pipeline inline (.apply()) so the document still reaches 'done' instead of
    # being stranded in 'queued'.
    def _boom(*args, **kwargs):
        raise RuntimeError("No such transport: ''")

    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "delay", _boom)

    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload(document_id="SOP-BROKER-1"))},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "done"
    rows = admin_repo.list_records(tenant_id="tenant-a")
    assert len(rows) == 1
    assert rows[0]["status"] == "done"
    assert rows[0]["chunk_count"] >= 1


def test_upload_503_when_async_and_inline_both_fail(monkeypatch, admin_repo, memory_store):
    # Only when BOTH async dispatch and the inline fallback fail is the document
    # marked 'failed' and the upload surfaced as a 503.
    def _boom(*args, **kwargs):
        raise RuntimeError("No such transport: ''")

    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "delay", _boom)
    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "apply", _boom)

    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload(document_id="SOP-BROKER-2"))},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    assert r.status_code == 503, r.text
    rows = admin_repo.list_records(tenant_id="tenant-a")
    assert len(rows) == 1
    assert rows[0]["status"] == "failed"
    assert "dispatch:" in (rows[0]["failure_reason"] or "")


def test_requeue_reruns_a_failed_document(monkeypatch, admin_repo, memory_store):
    # Drive a document into 'failed' by failing both async + inline dispatch.
    real_delay = routes_admin_documents.ingest_document_task.delay
    real_apply = routes_admin_documents.ingest_document_task.apply

    def _boom(*args, **kwargs):
        raise RuntimeError("No such transport: ''")

    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "delay", _boom)
    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "apply", _boom)

    up = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload(document_id="SOP-REQ-1"))},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    assert up.status_code == 503
    ingest_id = admin_repo.list_records(tenant_id="tenant-a")[0]["ingest_id"]

    # Dispatch healthy again: requeue should run the pipeline to completion.
    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "delay", real_delay)
    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "apply", real_apply)

    rq = client.post(f"/admin/documents/{ingest_id}/requeue", headers=_admin_headers())
    assert rq.status_code == 200, rq.text
    assert rq.json()["status"] == "done"

    record = admin_repo.get(tenant_id="tenant-a", ingest_id=ingest_id)
    assert record["failure_reason"] is None
    statuses = [s["status"] for s in record["status_history"]]
    assert statuses[-4:] == ["queued", "extracting", "embedding", "done"]


def test_requeue_rejects_done_document(admin_repo):
    up = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload(document_id="SOP-DONE-1"))},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    assert up.json()["status"] == "done"
    ingest_id = up.json()["ingest_id"]

    rq = client.post(f"/admin/documents/{ingest_id}/requeue", headers=_admin_headers())
    assert rq.status_code == 409
    assert "done" in rq.json()["detail"]


def test_requeue_unknown_id_404s():
    rq = client.post("/admin/documents/does-not-exist/requeue", headers=_admin_headers())
    assert rq.status_code == 404


def test_requeue_requires_admin_role():
    rq = client.post(
        "/admin/documents/whatever/requeue",
        headers=auth_headers(role="engineer", allowed_assets=["Asset-A"]),
    )
    assert rq.status_code == 403


def test_requeue_stuck_reruns_all_queued(monkeypatch, admin_repo, memory_store):
    # Two uploads land in 'failed' (both async + inline dispatch down), then a
    # bulk requeue heals both once dispatch works again.
    real_delay = routes_admin_documents.ingest_document_task.delay
    real_apply = routes_admin_documents.ingest_document_task.apply

    def _boom(*args, **kwargs):
        raise RuntimeError("No such transport: ''")

    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "delay", _boom)
    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "apply", _boom)
    for i in (1, 2):
        client.post(
            "/admin/documents",
            headers=_admin_headers(),
            data={"metadata": json.dumps(_payload(document_id=f"SOP-STUCK-{i}"))},
            files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
        )
    assert all(r["status"] == "failed" for r in admin_repo.list_records(tenant_id="tenant-a"))

    # Dispatch healthy again (don't undo() - that would revert the wire fixture).
    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "delay", real_delay)
    monkeypatch.setattr(routes_admin_documents.ingest_document_task, "apply", real_apply)

    rq = client.post("/admin/documents/requeue-stuck", headers=_admin_headers())
    assert rq.status_code == 200, rq.text
    body = rq.json()
    assert body["requeued"] == 2
    assert all(item["status"] == "done" for item in body["results"])
    assert all(r["status"] == "done" for r in admin_repo.list_records(tenant_id="tenant-a"))


def test_delete_removes_record_object_and_chunks(monkeypatch, admin_repo, memory_store):
    chunk_deletes: list[tuple[str, str]] = []

    async def _fake_delete_chunks(tenant_id, document_id):
        chunk_deletes.append((tenant_id, document_id))
        return 3

    monkeypatch.setattr(routes_admin_documents, "_delete_vector_chunks", _fake_delete_chunks)

    up = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload(document_id="SOP-DEL-1"))},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    assert up.json()["status"] == "done"
    ingest_id = up.json()["ingest_id"]
    object_key = admin_repo.get(tenant_id="tenant-a", ingest_id=ingest_id)["object_key"]

    rd = client.delete(f"/admin/documents/{ingest_id}", headers=_admin_headers())
    assert rd.status_code == 200, rd.text
    body = rd.json()
    assert body["deleted"] is True
    assert body["chunks_deleted"] == 3

    # Record gone, blob gone, chunks purged for this document_id.
    assert admin_repo.get(tenant_id="tenant-a", ingest_id=ingest_id) is None
    assert admin_repo.list_records(tenant_id="tenant-a") == []
    with pytest.raises(KeyError):
        memory_store.get(object_key)
    assert chunk_deletes == [("tenant-a", "SOP-DEL-1")]


def test_delete_keeps_chunks_when_a_sibling_shares_document_id(monkeypatch, admin_repo, memory_store):
    chunk_deletes: list[tuple[str, str]] = []

    async def _fake_delete_chunks(tenant_id, document_id):
        chunk_deletes.append((tenant_id, document_id))
        return 0

    monkeypatch.setattr(routes_admin_documents, "_delete_vector_chunks", _fake_delete_chunks)

    # Two uploads share the same document_id (chunks are keyed by document_id).
    ids = []
    for _ in range(2):
        up = client.post(
            "/admin/documents",
            headers=_admin_headers(),
            data={"metadata": json.dumps(_payload(document_id="SOP-DUP-1"))},
            files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
        )
        ids.append(up.json()["ingest_id"])

    # Deleting the first must NOT purge chunks - the sibling still represents them.
    rd = client.delete(f"/admin/documents/{ids[0]}", headers=_admin_headers())
    assert rd.status_code == 200
    assert rd.json()["chunks_deleted"] == 0
    assert chunk_deletes == []

    # Deleting the last sibling now purges the chunks.
    rd2 = client.delete(f"/admin/documents/{ids[1]}", headers=_admin_headers())
    assert rd2.status_code == 200
    assert chunk_deletes == [("tenant-a", "SOP-DUP-1")]


def test_delete_unknown_id_404s():
    rd = client.delete("/admin/documents/does-not-exist", headers=_admin_headers())
    assert rd.status_code == 404


def test_delete_requires_admin_role():
    rd = client.delete(
        "/admin/documents/whatever",
        headers=auth_headers(role="engineer", allowed_assets=["Asset-A"]),
    )
    assert rd.status_code == 403


def test_delete_is_tenant_isolated(monkeypatch, admin_repo):
    async def _noop(tenant_id, document_id):
        return 0

    monkeypatch.setattr(routes_admin_documents, "_delete_vector_chunks", _noop)

    up = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload(document_id="SOP-ISO-1"))},
        files={"file": ("kick.md", _KICK_MD.encode("utf-8"), "text/markdown")},
    )
    ingest_id = up.json()["ingest_id"]

    # Tenant B cannot delete tenant A's document.
    rd = client.delete(
        f"/admin/documents/{ingest_id}",
        headers=_admin_headers(tenant_id="tenant-b", user_id="bob", allowed_assets=["*"]),
    )
    assert rd.status_code == 404
    assert admin_repo.get(tenant_id="tenant-a", ingest_id=ingest_id) is not None


def test_worker_marks_failed_when_object_missing(admin_repo, memory_store):
    # Create the record by uploading, then nuke the bytes so the worker fails.
    r = client.post(
        "/admin/documents",
        headers=_admin_headers(),
        data={"metadata": json.dumps(_payload(document_id="SOP-MISS-1"))},
        files={"file": ("loss.md", b"# Loss\nMaintain hydrostatic.\n", "text/markdown")},
    )
    ingest_id = r.json()["ingest_id"]
    record = admin_repo.get(tenant_id="tenant-a", ingest_id=ingest_id)
    # First upload finished successfully (eager) so reset the record + delete the
    # object so a manual re-run flunks on extract.
    memory_store.delete(record["object_key"])
    from app.workers.ingest_worker import ingest_document_task
    result = ingest_document_task.apply(args=("tenant-a", ingest_id)).get()
    assert result["status"] == "failed"
    final = admin_repo.get(tenant_id="tenant-a", ingest_id=ingest_id)
    assert final["status"] == "failed"
    assert "extract" in (final["failure_reason"] or "")
