"""
Account area (Group 1) end-to-end:
- profile read/update + avatar upload/serve
- per-user settings read/update (incl. opportunity alerts)
- per-tenant org config read/update with role gating
- team roster (admin/auditor only)
- copilot memory list/edit/archive scoped to the creator (a user's own memories)
- tenant isolation across the settings stores
- auth required on every route
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_account
from app.db.account_repository import LocalJsonAccountRepository
from app.db.tenant_memory_repository import LocalJsonTenantMemoryRepository
from app.db.users_repository import LocalJsonUsersRepository
from app.main import app
from app.storage.object_store import InMemoryObjectStore
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


class _FakeAssets:
    """assetCount source: N assets for tenant t1, none elsewhere."""

    def __init__(self, n: int) -> None:
        self._n = n

    def list_records(self, *, tenant_id: str, **_kw):
        return [{"id": f"a{i}"} for i in range(self._n)] if tenant_id == "t1" else []


@pytest.fixture
def account_repo(tmp_path):
    return LocalJsonAccountRepository(
        tmp_path / "user_settings.jsonl", tmp_path / "org_settings.jsonl"
    )


@pytest.fixture
def memory_repo(tmp_path):
    return LocalJsonTenantMemoryRepository(tmp_path / "tenant_memories.jsonl")


@pytest.fixture
def users_repo(tmp_path):
    repo = LocalJsonUsersRepository(tmp_path / "users.jsonl")
    repo.signup(tenant_id="t1", email="owner@t1.io", role="admin",
                password_hash="x", id="u1")
    repo.invite(tenant_id="t1", email="invitee@t1.io", role="engineer")
    return repo


@pytest.fixture
def object_store():
    return InMemoryObjectStore()


@pytest.fixture(autouse=True)
def wire(monkeypatch, account_repo, memory_repo, users_repo, object_store):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    monkeypatch.setattr(routes_account, "get_account_repository", lambda: account_repo)
    monkeypatch.setattr(routes_account, "get_tenant_memory_repository", lambda: memory_repo)
    monkeypatch.setattr(routes_account, "get_users_repository", lambda: users_repo)
    monkeypatch.setattr(routes_account, "get_assets_repository", lambda: _FakeAssets(3))
    monkeypatch.setattr(routes_account, "get_object_store", lambda: object_store)


# ---- auth ---------------------------------------------------------------

def test_routes_require_auth():
    for method, path in [
        ("get", "/profile"), ("get", "/settings"), ("get", "/org"),
        ("get", "/team"), ("get", "/memory"),
    ]:
        r = getattr(client, method)(path)
        assert r.status_code == 401, f"{method} {path} -> {r.status_code}"


# ---- profile ------------------------------------------------------------

def test_profile_defaults_then_update():
    r = client.get("/profile", headers=auth_headers(tenant_id="t1", user_id="u1", role="admin"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == "u1"
    assert body["name"] == ""
    assert body["email"] == "owner@t1.io"   # resolved from the users table
    assert body["role"] == "admin"

    r = client.patch(
        "/profile",
        headers=auth_headers(tenant_id="t1", user_id="u1", role="admin"),
        json={"name": "Ada Lovelace"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Ada Lovelace"
    again = client.get("/profile", headers=auth_headers(tenant_id="t1", user_id="u1", role="admin"))
    assert again.json()["name"] == "Ada Lovelace"


def test_avatar_upload_and_serve():
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    r = client.post(
        "/profile/avatar",
        headers=auth_headers(tenant_id="t1", user_id="u1", role="admin"),
        files={"file": ("a.png", png, "image/png")},
    )
    assert r.status_code == 200, r.text
    assert r.json()["avatarUrl"].startswith("profile/avatar")

    got = client.get("/profile/avatar", headers=auth_headers(tenant_id="t1", user_id="u1", role="admin"))
    assert got.status_code == 200
    assert got.headers["content-type"] == "image/png"
    assert got.content == png


def test_avatar_rejects_non_image():
    r = client.post(
        "/profile/avatar",
        headers=auth_headers(tenant_id="t1", user_id="u1", role="admin"),
        files={"file": ("a.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 422


def test_avatar_404_when_unset():
    r = client.get("/profile/avatar", headers=auth_headers(tenant_id="t1", user_id="nobody", role="admin"))
    assert r.status_code == 404


# ---- settings -----------------------------------------------------------

def test_settings_defaults_and_update():
    r = client.get("/settings", headers=auth_headers(tenant_id="t1", user_id="u1"))
    assert r.status_code == 200
    body = r.json()
    assert body["units"] == "oilfield"
    assert body["notifications"] == {"product": True, "reports": True, "alerts": True}
    assert "opportunityAlerts" not in body

    r = client.patch(
        "/settings",
        headers=auth_headers(tenant_id="t1", user_id="u1"),
        json={
            "units": "metric",
            "notifications": {"product": False, "reports": True, "alerts": False},
            "opportunityAlerts": {
                "newRoundCountries": ["NG"],
                "deadlineReminders": True,
                "addendumOnWatched": False,
            },
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["units"] == "metric"
    assert body["notifications"]["product"] is False
    assert body["opportunityAlerts"]["newRoundCountries"] == ["NG"]


def test_settings_rejects_invalid_enum():
    r = client.patch(
        "/settings",
        headers=auth_headers(tenant_id="t1", user_id="u1"),
        json={"units": "furlongs"},
    )
    assert r.status_code == 422


# ---- org ----------------------------------------------------------------

def test_org_defaults_include_asset_count():
    r = client.get("/org", headers=auth_headers(tenant_id="t1", user_id="u1", role="admin"))
    assert r.status_code == 200
    body = r.json()
    assert body["segment"] == "upstream"
    assert body["gwpSet"] == "ar6"
    assert body["assetCount"] == 3


def test_org_update_requires_admin():
    r = client.patch(
        "/org",
        headers=auth_headers(tenant_id="t1", user_id="u2", role="engineer"),
        json={"company": "Acme"},
    )
    assert r.status_code == 403


def test_org_update_persists_for_admin():
    r = client.patch(
        "/org",
        headers=auth_headers(tenant_id="t1", user_id="u1", role="admin"),
        json={
            "company": "Acme Oil",
            "reportingBoundary": "equity_share",
            "gwpSet": "ar5",
            "frameworks": ["gri", "issb"],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["company"] == "Acme Oil"
    assert body["reportingBoundary"] == "equity_share"
    assert body["gwpSet"] == "ar5"
    assert body["frameworks"] == ["gri", "issb"]
    # And the profile card now surfaces the org name.
    prof = client.get("/profile", headers=auth_headers(tenant_id="t1", user_id="u1", role="admin"))
    assert prof.json()["org"] == "Acme Oil"


# ---- team ---------------------------------------------------------------

def test_team_visible_to_admin_and_auditor():
    for role in ("admin", "auditor"):
        r = client.get("/team", headers=auth_headers(tenant_id="t1", role=role))
        assert r.status_code == 200, role
        emails = {m["email"] for m in r.json()["items"]}
        assert "owner@t1.io" in emails
    invitee = next(
        m for m in client.get("/team", headers=auth_headers(tenant_id="t1", role="admin")).json()["items"]
        if m["email"] == "invitee@t1.io"
    )
    assert invitee["status"] == "invited"


def test_team_forbidden_for_engineer():
    r = client.get("/team", headers=auth_headers(tenant_id="t1", role="engineer"))
    assert r.status_code == 403


# ---- memory -------------------------------------------------------------

def test_memory_list_edit_archive(memory_repo):
    m = memory_repo.create(tenant_id="t1", kind="preference",
                           body="Default unit is metric.", created_by="u1")
    r = client.get("/memory", headers=auth_headers(tenant_id="t1", user_id="u1"))
    assert r.status_code == 200
    items = r.json()["items"]
    assert any(i["id"] == m.id and i["content"] == "Default unit is metric." for i in items)

    # The owner can edit their own memory regardless of role (engineer here).
    r = client.patch(
        f"/memory/{m.id}",
        headers=auth_headers(tenant_id="t1", user_id="u1", role="engineer"),
        json={"content": "We report flaring in mscf."},
    )
    assert r.status_code == 200, r.text
    assert r.json()["content"] == "We report flaring in mscf."

    r = client.delete(f"/memory/{m.id}", headers=auth_headers(tenant_id="t1", user_id="u1"))
    assert r.status_code == 204
    remaining = client.get(
        "/memory", headers=auth_headers(tenant_id="t1", user_id="u1")
    ).json()["items"]
    assert all(i["id"] != m.id for i in remaining)


def test_memory_is_scoped_to_creator(memory_repo):
    """A memory created by u1 is invisible to (and unmanageable by) u2."""
    m = memory_repo.create(tenant_id="t1", kind="preference",
                           body="Default unit is metric.", created_by="u1")
    # u2 cannot see u1's memory on their own account page...
    seen = client.get(
        "/memory", headers=auth_headers(tenant_id="t1", user_id="u2")
    ).json()["items"]
    assert all(i["id"] != m.id for i in seen)
    # ...and cannot edit or archive it (404, not 403 - never leak existence).
    r = client.patch(
        f"/memory/{m.id}",
        headers=auth_headers(tenant_id="t1", user_id="u2", role="admin"),
        json={"content": "We report flaring in mscf."},
    )
    assert r.status_code == 404
    r = client.delete(
        f"/memory/{m.id}", headers=auth_headers(tenant_id="t1", user_id="u2", role="admin")
    )
    assert r.status_code == 404


# ---- tenant isolation ---------------------------------------------------

def test_settings_are_tenant_isolated():
    client.patch(
        "/settings",
        headers=auth_headers(tenant_id="t1", user_id="u1"),
        json={"units": "metric"},
    )
    # Same user_id, different tenant -> must see defaults, not t1's value.
    other = client.get("/settings", headers=auth_headers(tenant_id="t2", user_id="u1"))
    assert other.json()["units"] == "oilfield"
