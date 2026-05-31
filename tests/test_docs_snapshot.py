"""GET /docs/snapshot - tenant-scoped incremental SOP snapshot for the field
offline cache (full docs with chunks, `since` filtering)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_documents
from app.db.document_repository import LocalJsonDocumentRepository
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings

client = TestClient(app)


@pytest.fixture
def repo(tmp_path):
    return LocalJsonDocumentRepository(tmp_path / "documents.jsonl")


@pytest.fixture(autouse=True)
def wire(monkeypatch, repo):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    monkeypatch.setattr(routes_documents, "get_document_repository", lambda: repo)


def _save(repo, *, tenant_id, document_id):
    return repo.save(
        tenant_id=tenant_id, user_id="u1",
        request={"document_id": document_id, "title": document_id, "filename": "s.txt"},
        chunks=[{"clause": "1.0", "text": "body"}],
    )


def test_full_snapshot_returns_docs_with_chunks(repo):
    _save(repo, tenant_id="tenant-a", document_id="SOP-1")
    _save(repo, tenant_id="tenant-a", document_id="SOP-2")
    body = client.get("/docs/snapshot", headers=auth_headers(tenant_id="tenant-a")).json()
    assert body["count"] == 2
    assert {d["document_id"] for d in body["documents"]} == {"SOP-1", "SOP-2"}
    assert all(d["chunks"] for d in body["documents"])  # full records for offline cache
    assert body["as_of"]


def test_incremental_snapshot_since(repo):
    d1 = _save(repo, tenant_id="tenant-a", document_id="SOP-1")
    _save(repo, tenant_id="tenant-a", document_id="SOP-2")
    body = client.get("/docs/snapshot", params={"since": d1.created_utc},
                      headers=auth_headers(tenant_id="tenant-a")).json()
    assert {d["document_id"] for d in body["documents"]} == {"SOP-2"}


def test_snapshot_is_tenant_scoped(repo):
    _save(repo, tenant_id="tenant-a", document_id="SOP-1")
    body = client.get("/docs/snapshot", headers=auth_headers(tenant_id="tenant-b")).json()
    assert body["count"] == 0
