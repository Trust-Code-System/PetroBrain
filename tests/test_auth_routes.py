"""Self-serve signup/signin flow tests for /auth."""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_auth
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
    # deps.get_principal needs the same JWT secret/iss/aud routes_auth mints with.
    monkeypatch.setattr(deps, "get_settings", lambda: settings)
    monkeypatch.setattr(routes_auth, "get_settings", lambda: settings)
    monkeypatch.setattr(routes_auth, "get_users_repository", lambda: users_repo)
    monkeypatch.setattr(routes_auth, "get_tenants_repository", lambda: tenants_repo)


def test_signup_creates_active_user_in_default_tenant_and_returns_jwt(tenants_repo, users_repo):
    r = client.post("/auth/signup", json={"email": "alice@example.com", "password": "hunter2hunter2"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["principal"]["email"] == "alice@example.com"
    assert body["principal"]["tenant_id"] == "demo"
    assert body["principal"]["role"] == "engineer"
    assert body["token"]

    # Default tenant was bootstrapped on first signup.
    assert tenants_repo.get("demo") is not None
    # User row landed active with a hash, not the plain password.
    row = users_repo.get_by_email(tenant_id="demo", email="alice@example.com")
    assert row is not None
    assert row["status"] == "active"
    assert row["password_hash"] and row["password_hash"] != "hunter2hunter2"


def test_signup_rejects_duplicate_email():
    client.post("/auth/signup", json={"email": "dup@example.com", "password": "hunter2hunter2"})
    r = client.post("/auth/signup", json={"email": "dup@example.com", "password": "anotherone1"})
    assert r.status_code == 409
    assert "already" in r.json()["detail"].lower()


def test_signup_rejects_short_password():
    r = client.post("/auth/signup", json={"email": "shorty@example.com", "password": "abc"})
    assert r.status_code == 422
    assert "8 character" in r.json()["detail"]


def test_signup_rejects_invalid_email():
    r = client.post("/auth/signup", json={"email": "not-an-email", "password": "longenough1"})
    assert r.status_code == 422


def test_signup_disabled_returns_403(monkeypatch):
    monkeypatch.setattr(
        routes_auth, "get_settings",
        lambda: _auth_settings(enable_self_signup=False),
    )
    r = client.post("/auth/signup", json={"email": "x@example.com", "password": "longenough1"})
    assert r.status_code == 403


def test_signin_succeeds_with_correct_password():
    client.post("/auth/signup", json={"email": "bob@example.com", "password": "correcthorse1"})
    r = client.post("/auth/signin", json={"email": "bob@example.com", "password": "correcthorse1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["principal"]["email"] == "bob@example.com"
    assert body["token"]


def test_signin_is_case_insensitive_on_email():
    client.post("/auth/signup", json={"email": "case@example.com", "password": "correcthorse1"})
    r = client.post("/auth/signin", json={"email": "CASE@Example.com", "password": "correcthorse1"})
    assert r.status_code == 200


def test_signin_with_wrong_password_returns_401():
    client.post("/auth/signup", json={"email": "carol@example.com", "password": "correcthorse1"})
    r = client.post("/auth/signin", json={"email": "carol@example.com", "password": "wrongpass1"})
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid email or password"


def test_signin_with_unknown_email_returns_401_same_as_wrong_password():
    r = client.post("/auth/signin", json={"email": "ghost@example.com", "password": "anything1"})
    assert r.status_code == 401
    assert r.json()["detail"] == "invalid email or password"


def test_signin_blocks_deactivated_user(users_repo):
    client.post("/auth/signup", json={"email": "dave@example.com", "password": "correcthorse1"})
    row = users_repo.get_by_email(tenant_id="demo", email="dave@example.com")
    users_repo.set_status(tenant_id="demo", user_id=row["id"], status="deactivated")
    r = client.post("/auth/signin", json={"email": "dave@example.com", "password": "correcthorse1"})
    assert r.status_code == 401


def test_signup_token_works_against_protected_route():
    r = client.post("/auth/signup", json={"email": "eve@example.com", "password": "correcthorse1"})
    assert r.status_code == 201
    token = r.json()["token"]

    # Hit a route that depends on get_principal to confirm the JWT validates
    # against the same secret/iss/aud the rest of the API uses.
    chat_check = client.get(
        "/admin/tenants/demo/users",
        headers={"Authorization": f"Bearer {token}"},
    )
    # engineer role is denied (only platform_admin/admin), proving the JWT was
    # decoded and the principal was rebuilt; we don't care about 200 here.
    assert chat_check.status_code == 403
