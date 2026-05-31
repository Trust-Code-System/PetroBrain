"""B8 backend tests - tenants CRUD, users CRUD, role gates."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_admin_tenants, routes_admin_users
from app.db.tenants_repository import LocalJsonTenantsRepository
from app.db.users_repository import LocalJsonUsersRepository
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


@pytest.fixture
def tenants_repo(tmp_path):
    return LocalJsonTenantsRepository(tmp_path / "tenants.jsonl")


@pytest.fixture
def users_repo(tmp_path):
    return LocalJsonUsersRepository(tmp_path / "users.jsonl")


@pytest.fixture(autouse=True)
def wire(monkeypatch, tenants_repo, users_repo):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    monkeypatch.setattr(routes_admin_tenants, "_repository", lambda: tenants_repo)
    monkeypatch.setattr(routes_admin_users, "_repository", lambda: users_repo)


def _platform_headers(**overrides):
    return auth_headers(
        tenant_id=overrides.pop("tenant_id", "__platform__"),
        user_id=overrides.pop("user_id", "owner"),
        role=overrides.pop("role", "platform_admin"),
        allowed_assets=overrides.pop("allowed_assets", ["*"]),
        **overrides,
    )


def _tenant_admin_headers(**overrides):
    return auth_headers(
        tenant_id=overrides.pop("tenant_id", "tenant-a"),
        user_id=overrides.pop("user_id", "alice"),
        role=overrides.pop("role", "admin"),
        allowed_assets=overrides.pop("allowed_assets", ["*"]),
        **overrides,
    )


# ---- tenants --------------------------------------------------------------


def test_platform_admin_creates_and_lists_tenants(tenants_repo):
    r = client.post(
        "/admin/tenants",
        headers=_platform_headers(),
        json={"id": "tenant-a", "name": "Operator A"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "active"
    assert body["name"] == "Operator A"

    listing = client.get("/admin/tenants", headers=_platform_headers()).json()
    assert {t["id"] for t in listing["tenants"]} == {"tenant-a"}


def test_create_tenant_rejects_duplicate_id(tenants_repo):
    headers = _platform_headers()
    client.post("/admin/tenants", headers=headers, json={"id": "t1", "name": "n"})
    r = client.post("/admin/tenants", headers=headers, json={"id": "t1", "name": "n2"})
    assert r.status_code == 422
    assert "already exists" in r.json()["detail"]


def test_tenant_admin_cannot_list_tenants(tenants_repo):
    r = client.get("/admin/tenants", headers=_tenant_admin_headers())
    assert r.status_code == 403


def test_tenant_admin_can_read_own_tenant(tenants_repo):
    tenants_repo.create(id="tenant-a", name="Operator A")
    r = client.get("/admin/tenants/tenant-a", headers=_tenant_admin_headers())
    assert r.status_code == 200
    assert r.json()["id"] == "tenant-a"


def test_tenant_admin_cannot_read_other_tenant(tenants_repo):
    tenants_repo.create(id="tenant-a", name="Operator A")
    tenants_repo.create(id="tenant-b", name="Operator B")
    r = client.get(
        "/admin/tenants/tenant-b",
        headers=_tenant_admin_headers(tenant_id="tenant-a"),
    )
    assert r.status_code == 403


def test_platform_admin_can_suspend_a_tenant(tenants_repo):
    tenants_repo.create(id="tenant-a", name="Operator A")
    r = client.patch(
        "/admin/tenants/tenant-a",
        headers=_platform_headers(),
        json={"status": "suspended"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "suspended"


def test_patch_unknown_status_is_422(tenants_repo):
    tenants_repo.create(id="tenant-a", name="Operator A")
    r = client.patch(
        "/admin/tenants/tenant-a",
        headers=_platform_headers(),
        json={"status": "exploded"},
    )
    assert r.status_code == 422


# ---- users ----------------------------------------------------------------


def test_tenant_admin_invites_user_in_own_tenant(users_repo):
    r = client.post(
        "/admin/tenants/tenant-a/users",
        headers=_tenant_admin_headers(),
        json={"email": "bob@example.com", "role": "engineer", "allowed_assets": ["*"]},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] == "bob@example.com"
    assert body["role"] == "engineer"
    assert body["status"] == "invited"


def test_tenant_admin_cannot_invite_in_other_tenant(users_repo):
    r = client.post(
        "/admin/tenants/tenant-b/users",
        headers=_tenant_admin_headers(tenant_id="tenant-a"),
        json={"email": "x@example.com", "role": "engineer"},
    )
    assert r.status_code == 403


def test_platform_admin_can_invite_into_any_tenant(users_repo):
    r = client.post(
        "/admin/tenants/tenant-b/users",
        headers=_platform_headers(),
        json={"email": "founder@example.com", "role": "admin"},
    )
    assert r.status_code == 201


def test_invite_duplicate_email_is_422(users_repo):
    headers = _tenant_admin_headers()
    body = {"email": "bob@example.com", "role": "engineer"}
    client.post("/admin/tenants/tenant-a/users", headers=headers, json=body)
    r = client.post("/admin/tenants/tenant-a/users", headers=headers, json=body)
    assert r.status_code == 422
    assert "already exists" in r.json()["detail"]


def test_invite_unknown_role_is_422(users_repo):
    r = client.post(
        "/admin/tenants/tenant-a/users",
        headers=_tenant_admin_headers(),
        json={"email": "bob@example.com", "role": "intruder"},
    )
    assert r.status_code == 422
    assert "unknown role" in r.json()["detail"]


def test_engineer_role_cannot_invite_users(users_repo):
    r = client.post(
        "/admin/tenants/tenant-a/users",
        headers=auth_headers(
            tenant_id="tenant-a", user_id="bob", role="engineer", allowed_assets=["*"],
        ),
        json={"email": "x@example.com", "role": "engineer"},
    )
    assert r.status_code == 403


def test_list_users_filters_by_status_and_role(users_repo):
    users_repo.invite(tenant_id="tenant-a", email="a@x", role="engineer")
    bob = users_repo.invite(tenant_id="tenant-a", email="b@x", role="hse")
    users_repo.set_status(tenant_id="tenant-a", user_id=bob.id, status="active")

    by_status = client.get(
        "/admin/tenants/tenant-a/users?status=active",
        headers=_tenant_admin_headers(),
    ).json()
    assert {u["email"] for u in by_status["users"]} == {"b@x"}

    by_role = client.get(
        "/admin/tenants/tenant-a/users?role=engineer",
        headers=_tenant_admin_headers(),
    ).json()
    assert {u["email"] for u in by_role["users"]} == {"a@x"}


def test_tenant_admin_sets_role_and_status(users_repo):
    invited = users_repo.invite(tenant_id="tenant-a", email="x@x", role="field")

    promote = client.patch(
        f"/admin/tenants/tenant-a/users/{invited.id}/role",
        headers=_tenant_admin_headers(),
        json={"role": "engineer"},
    )
    assert promote.status_code == 200
    assert promote.json()["role"] == "engineer"

    activate = client.patch(
        f"/admin/tenants/tenant-a/users/{invited.id}/status",
        headers=_tenant_admin_headers(),
        json={"status": "active"},
    )
    assert activate.status_code == 200
    assert activate.json()["status"] == "active"

    deactivate = client.patch(
        f"/admin/tenants/tenant-a/users/{invited.id}/status",
        headers=_tenant_admin_headers(),
        json={"status": "deactivated"},
    )
    assert deactivate.status_code == 200
    assert deactivate.json()["status"] == "deactivated"


def test_set_status_unknown_value_is_422(users_repo):
    invited = users_repo.invite(tenant_id="tenant-a", email="x@x", role="field")
    r = client.patch(
        f"/admin/tenants/tenant-a/users/{invited.id}/status",
        headers=_tenant_admin_headers(),
        json={"status": "ghosted"},
    )
    assert r.status_code == 422


def test_set_allowed_assets(users_repo):
    invited = users_repo.invite(tenant_id="tenant-a", email="x@x", role="field")
    r = client.patch(
        f"/admin/tenants/tenant-a/users/{invited.id}/allowed-assets",
        headers=_tenant_admin_headers(),
        json={"allowed_assets": ["A-101", "A-102"]},
    )
    assert r.status_code == 200
    assert r.json()["allowed_assets"] == ["A-101", "A-102"]


def test_set_role_user_not_found_is_404(users_repo):
    r = client.patch(
        "/admin/tenants/tenant-a/users/no-such/role",
        headers=_tenant_admin_headers(),
        json={"role": "engineer"},
    )
    assert r.status_code == 404
