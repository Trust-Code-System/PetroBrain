"""B8 backend tests - platform_admin cross-tenant audit override."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_admin_audit
from app.db.audit_events_repository import LocalJsonAuditEventsRepository
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


@pytest.fixture
def events_repo(tmp_path):
    return LocalJsonAuditEventsRepository(tmp_path / "audit_events.jsonl")


@pytest.fixture(autouse=True)
def wire(monkeypatch, events_repo):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    monkeypatch.setattr(routes_admin_audit, "_repository", lambda: events_repo)


def _seed(events_repo, tenant):
    events_repo.append(
        tenant_id=tenant,
        user_id="u1",
        role="engineer",
        action="chat",
        module="general",
        request_hash="a" * 64,
        response_hash="b" * 64,
    )


def test_platform_admin_reads_other_tenant_with_query_param(events_repo):
    _seed(events_repo, "tenant-a")
    _seed(events_repo, "tenant-b")

    headers = auth_headers(
        tenant_id="__platform__", role="platform_admin", allowed_assets=["*"],
    )
    a = client.get("/admin/audit?tenant_id=tenant-a", headers=headers).json()
    b = client.get("/admin/audit?tenant_id=tenant-b", headers=headers).json()
    assert a["tenant_id"] == "tenant-a" and len(a["events"]) == 1
    assert b["tenant_id"] == "tenant-b" and len(b["events"]) == 1


def test_platform_admin_without_query_uses_own_tenant(events_repo):
    _seed(events_repo, "__platform__")
    _seed(events_repo, "tenant-a")
    headers = auth_headers(
        tenant_id="__platform__", role="platform_admin", allowed_assets=["*"],
    )
    r = client.get("/admin/audit", headers=headers).json()
    assert r["tenant_id"] == "__platform__"
    assert len(r["events"]) == 1


def test_tenant_admin_cannot_override_tenant_id(events_repo):
    _seed(events_repo, "tenant-a")
    _seed(events_repo, "tenant-b")
    r = client.get(
        "/admin/audit?tenant_id=tenant-b",
        headers=auth_headers(tenant_id="tenant-a", role="admin", allowed_assets=["*"]),
    )
    assert r.status_code == 403


def test_tenant_admin_can_pass_own_tenant_id_explicitly(events_repo):
    _seed(events_repo, "tenant-a")
    r = client.get(
        "/admin/audit?tenant_id=tenant-a",
        headers=auth_headers(tenant_id="tenant-a", role="admin", allowed_assets=["*"]),
    ).json()
    assert r["tenant_id"] == "tenant-a"


def test_engineer_still_blocked(events_repo):
    r = client.get(
        "/admin/audit",
        headers=auth_headers(tenant_id="tenant-a", role="engineer", allowed_assets=["*"]),
    )
    assert r.status_code == 403
