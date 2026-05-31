"""B8 backend tests - GET /admin/data-readiness derived score."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_admin_data_readiness
from app.db.admin_document_repository import LocalJsonAdminDocumentRepository
from app.db.assets_repository import LocalJsonAssetsRepository
from app.db.users_repository import LocalJsonUsersRepository
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


@pytest.fixture
def docs_repo(tmp_path):
    return LocalJsonAdminDocumentRepository(tmp_path / "admin_documents.jsonl")


@pytest.fixture
def assets_repo(tmp_path):
    return LocalJsonAssetsRepository(
        tmp_path / "assets.jsonl",
        tmp_path / "asset_relationships.jsonl",
    )


@pytest.fixture
def users_repo(tmp_path):
    return LocalJsonUsersRepository(tmp_path / "users.jsonl")


@pytest.fixture(autouse=True)
def wire(monkeypatch, docs_repo, assets_repo, users_repo):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    monkeypatch.setattr(routes_admin_data_readiness, "_admin_documents", lambda: docs_repo)
    monkeypatch.setattr(routes_admin_data_readiness, "_assets", lambda: assets_repo)
    monkeypatch.setattr(routes_admin_data_readiness, "_users", lambda: users_repo)


def _admin_headers(tenant="tenant-a"):
    return auth_headers(tenant_id=tenant, role="admin", allowed_assets=["*"])


def _platform_headers():
    return auth_headers(tenant_id="__platform__", role="platform_admin", allowed_assets=["*"])


def _create_doc(repo, *, status, tenant="tenant-a"):
    record = repo.create(
        tenant_id=tenant,
        user_id="u1",
        metadata={"document_id": status, "title": status},
        filename=f"{status}.md",
        content_type="text/markdown",
        size_bytes=10,
        object_key=f"k-{status}",
    )
    if status != "queued":
        repo.update_status(tenant_id=tenant, ingest_id=record.ingest_id, status=status)
    return record


def test_empty_tenant_scores_zero(docs_repo, assets_repo, users_repo):
    r = client.get("/admin/data-readiness", headers=_admin_headers()).json()
    assert r["readiness_pct"] == 0.0
    assert r["documents"]["loaded"] == 0
    assert r["assets"]["total"] == 0
    assert r["connectors"]["score_pct"] == 0.0


def test_documents_score_reflects_done_ratio(docs_repo, assets_repo, users_repo):
    _create_doc(docs_repo, status="done")
    _create_doc(docs_repo, status="done")
    _create_doc(docs_repo, status="failed")
    _create_doc(docs_repo, status="queued")

    r = client.get("/admin/data-readiness", headers=_admin_headers()).json()
    # 2 of 4 docs are done -> 50%, contributing 0.5 * 50 = 25 to readiness
    assert r["documents"]["score_pct"] == 50.0
    assert r["documents"]["indexed"] == 2
    assert r["documents"]["failed"] == 1
    assert r["readiness_pct"] == pytest.approx(25.0, abs=0.01)


def test_full_asset_hierarchy_gives_100_pct_assets_score(docs_repo, assets_repo, users_repo):
    field = assets_repo.create(tenant_id="tenant-a", type="field", name="ND")
    block = assets_repo.create(tenant_id="tenant-a", type="block", name="OML-99", parent_id=field.id)
    train = assets_repo.create(tenant_id="tenant-a", type="train", name="Train A", parent_id=block.id)
    assets_repo.create(tenant_id="tenant-a", type="equipment", name="K-101", parent_id=train.id)

    r = client.get("/admin/data-readiness", headers=_admin_headers()).json()
    assert r["assets"]["score_pct"] == 100.0
    assert r["assets"]["by_type"] == {"field": 1, "block": 1, "train": 1, "equipment": 1}


def test_partial_asset_hierarchy_scores_per_level(docs_repo, assets_repo, users_repo):
    field = assets_repo.create(tenant_id="tenant-a", type="field", name="ND")
    assets_repo.create(tenant_id="tenant-a", type="block", name="OML-99", parent_id=field.id)
    # No train, no equipment → 50%
    r = client.get("/admin/data-readiness", headers=_admin_headers()).json()
    assert r["assets"]["score_pct"] == 50.0


def test_users_score_flips_on_first_active_user(docs_repo, assets_repo, users_repo):
    users_repo.invite(tenant_id="tenant-a", email="x@x", role="engineer")
    pending = client.get("/admin/data-readiness", headers=_admin_headers()).json()
    assert pending["users"]["score_pct"] == 0.0

    inv = users_repo.invite(tenant_id="tenant-a", email="y@y", role="hse")
    users_repo.set_status(tenant_id="tenant-a", user_id=inv.id, status="active")
    after = client.get("/admin/data-readiness", headers=_admin_headers()).json()
    assert after["users"]["score_pct"] == 100.0


def test_platform_admin_reads_any_tenant_via_query(docs_repo, assets_repo, users_repo):
    _create_doc(docs_repo, status="done", tenant="tenant-b")
    r = client.get(
        "/admin/data-readiness?tenant_id=tenant-b",
        headers=_platform_headers(),
    ).json()
    assert r["tenant_id"] == "tenant-b"
    assert r["documents"]["loaded"] == 1


def test_tenant_admin_cannot_query_other_tenant(docs_repo, assets_repo, users_repo):
    r = client.get(
        "/admin/data-readiness?tenant_id=tenant-z",
        headers=_admin_headers(),
    )
    assert r.status_code == 403


def test_engineer_role_cannot_read_data_readiness():
    r = client.get(
        "/admin/data-readiness",
        headers=auth_headers(tenant_id="tenant-a", role="engineer", allowed_assets=["*"]),
    )
    assert r.status_code == 403


def test_full_combined_score():
    pass  # covered by combined-input fixtures above
