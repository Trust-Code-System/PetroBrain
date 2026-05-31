"""POST/GET /admin/permits - field permit flush (idempotent), tenant-scoped,
admin-only read."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_admin_permits
from app.core.audit import AuditLogger
from app.db.permits_repository import LocalJsonPermitsRepository
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings

client = TestClient(app)


@pytest.fixture
def repo(tmp_path):
    return LocalJsonPermitsRepository(tmp_path / "permits.jsonl")


@pytest.fixture(autouse=True)
def wire(monkeypatch, repo, tmp_path):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    monkeypatch.setattr(routes_admin_permits, "_repository", lambda: repo)
    monkeypatch.setattr(routes_admin_permits, "audit_logger", AuditLogger(tmp_path / "audit.jsonl"))


def _engineer(tenant_id="tenant-a"):
    return auth_headers(tenant_id=tenant_id, user_id="bob", role="engineer", allowed_assets=["*"])


def _admin(tenant_id="tenant-a"):
    return auth_headers(tenant_id=tenant_id, user_id="alice", role="admin", allowed_assets=["*"])


def test_field_flush_and_admin_review():
    r = client.post("/admin/permits", headers=_engineer(),
                    json={"id": "p1", "form": {"work": "hot work"}, "signatures": [{"name": "Bob"}]})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["id"] == "p1"
    assert body["tenant_id"] == "tenant-a"
    assert body["user_id"] == "bob"
    assert body["status"] == "submitted"

    listing = client.get("/admin/permits", headers=_admin()).json()
    assert {p["id"] for p in listing["permits"]} == {"p1"}


def test_flush_is_idempotent_and_updates_status():
    client.post("/admin/permits", headers=_engineer(), json={"id": "p1", "status": "submitted"})
    client.post("/admin/permits", headers=_engineer(), json={"id": "p1", "status": "approved"})
    listing = client.get("/admin/permits", headers=_admin()).json()
    assert len(listing["permits"]) == 1
    assert listing["permits"][0]["status"] == "approved"


def test_permits_are_tenant_scoped():
    client.post("/admin/permits", headers=_engineer("tenant-a"), json={"id": "p1"})
    other = client.get("/admin/permits", headers=_admin("tenant-b")).json()
    assert other["permits"] == []


def test_engineer_cannot_review_permits():
    r = client.get("/admin/permits", headers=_engineer())
    assert r.status_code == 403


def test_permit_requires_id():
    r = client.post("/admin/permits", headers=_engineer(), json={"form": {}})
    assert r.status_code == 422  # pydantic: id is required
