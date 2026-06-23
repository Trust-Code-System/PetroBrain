"""Refresh-token flow tests for /auth/refresh (rotation, single-use, re-validation)."""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_auth
from app.core import refresh_tokens
from app.db.tenants_repository import LocalJsonTenantsRepository
from app.db.users_repository import LocalJsonUsersRepository
from app.main import app
from tests.auth_helpers import JWT_AUDIENCE, JWT_ISSUER, JWT_SECRET


client = TestClient(app)


def _auth_settings(**overrides):
    base = {
        "jwt_secret": JWT_SECRET,
        "jwt_public_key": "",
        "jwt_issuer": JWT_ISSUER,
        "jwt_audience": JWT_AUDIENCE,
        "jwt_ttl_hours": 1,
        "refresh_token_ttl_days": 14,
        "enable_self_signup": True,
        "default_signup_tenant_id": "demo",
        "default_signup_tenant_name": "Demo",
        "default_signup_role": "engineer",
        "password_min_length": 8,
    }
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.fixture
def tenants_repo(tmp_path):
    return LocalJsonTenantsRepository(tmp_path / "tenants.jsonl")


@pytest.fixture
def users_repo(tmp_path):
    return LocalJsonUsersRepository(tmp_path / "users.jsonl")


@pytest.fixture(autouse=True)
def wire(monkeypatch, tenants_repo, users_repo):
    settings = _auth_settings()
    monkeypatch.setattr(deps, "get_settings", lambda: settings)
    monkeypatch.setattr(routes_auth, "get_settings", lambda: settings)
    monkeypatch.setattr(routes_auth, "get_users_repository", lambda: users_repo)
    monkeypatch.setattr(routes_auth, "get_tenants_repository", lambda: tenants_repo)
    from app.core import auth_lockout
    auth_lockout.reset_for_tests()
    # Per-process refresh store: reset so tokens don't bleed across cases.
    refresh_tokens.reset_for_tests()
    # The IP-keyed auth rate limiter is a process-global singleton shared with the
    # other auth test files; clear it so accumulated signup/refresh hits from a
    # prior test don't 429 this one.
    from app.core.http_hardening import clear_rate_limits
    clear_rate_limits()


def _signup(email="user@example.com", password="correcthorse1"):
    r = client.post("/auth/signup", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()


def test_signup_and_signin_return_a_refresh_token():
    body = _signup()
    assert body["refresh_token"]
    signin = client.post(
        "/auth/signin", json={"email": "user@example.com", "password": "correcthorse1"}
    )
    assert signin.status_code == 200
    assert signin.json()["refresh_token"]


def test_refresh_returns_new_access_and_rotates_refresh_token():
    body = _signup()
    old_refresh = body["refresh_token"]

    r = client.post("/auth/refresh", json={"refresh_token": old_refresh})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["token"]
    assert out["refresh_token"]
    # Rotation: a brand-new refresh token is issued.
    assert out["refresh_token"] != old_refresh
    # The principal is preserved across refresh.
    assert out["principal"]["email"] == "user@example.com"


def test_new_access_token_works_against_a_protected_route():
    body = _signup()
    refreshed = client.post(
        "/auth/refresh", json={"refresh_token": body["refresh_token"]}
    ).json()
    # Decoded + principal rebuilt -> cross-tenant admin call is authoured and denied (403),
    # proving the freshly minted access token validates.
    r = client.get(
        "/admin/tenants/demo/users",
        headers={"Authorization": f"Bearer {refreshed['token']}"},
    )
    assert r.status_code == 403


def test_old_refresh_token_is_single_use():
    body = _signup()
    old_refresh = body["refresh_token"]
    assert client.post("/auth/refresh", json={"refresh_token": old_refresh}).status_code == 200
    # Replaying the now-rotated token must fail.
    replay = client.post("/auth/refresh", json={"refresh_token": old_refresh})
    assert replay.status_code == 401
    assert replay.json()["detail"] == "invalid refresh token"


def test_refresh_with_unknown_token_returns_401():
    r = client.post("/auth/refresh", json={"refresh_token": "not-a-real-token"})
    assert r.status_code == 401


def test_refresh_rejected_for_deactivated_user(users_repo):
    body = _signup(email="gone@example.com")
    tenant_id = body["principal"]["tenant_id"]
    row = users_repo.get_by_email(tenant_id=tenant_id, email="gone@example.com")
    users_repo.set_status(tenant_id=tenant_id, user_id=row["id"], status="deactivated")

    r = client.post("/auth/refresh", json={"refresh_token": body["refresh_token"]})
    assert r.status_code == 401


def test_logout_revokes_refresh_token():
    body = _signup()
    token = body["token"]
    refresh = body["refresh_token"]

    out = client.post(
        "/auth/logout",
        headers={"Authorization": f"Bearer {token}"},
        json={"refresh_token": refresh},
    )
    assert out.status_code == 204
    # The refresh token is dead after logout.
    r = client.post("/auth/refresh", json={"refresh_token": refresh})
    assert r.status_code == 401


def test_logout_still_works_without_a_refresh_token_body():
    body = _signup()
    out = client.post(
        "/auth/logout",
        headers={"Authorization": f"Bearer {body['token']}"},
    )
    assert out.status_code == 204
