"""Forgot-password / reset-password flow tests for /auth."""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_auth
from app.core import password_reset
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
        "refresh_token_backend": "memory",
        "enable_self_signup": True,
        "default_signup_tenant_id": "demo",
        "default_signup_tenant_name": "Demo",
        "default_signup_role": "engineer",
        "password_min_length": 8,
        "password_reset_ttl_minutes": 30,
        "environment": "dev",
        "resend_api_key": "",
    }
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.fixture
def tenants_repo(tmp_path):
    return LocalJsonTenantsRepository(tmp_path / "tenants.jsonl")


@pytest.fixture
def users_repo(tmp_path):
    return LocalJsonUsersRepository(tmp_path / "users.jsonl")


@pytest.fixture
def captured_emails(monkeypatch):
    """Capture password-reset emails instead of sending them, exposing the raw
    token so a test can drive the second leg of the flow."""
    sent: list[dict] = []

    def _fake_send(*, to_email, raw_token, ttl_minutes):
        sent.append({"to_email": to_email, "raw_token": raw_token})
        return {"email_sent": True, "message": "sent"}

    monkeypatch.setattr("app.core.email.send_password_reset_email", _fake_send)
    return sent


@pytest.fixture(autouse=True)
def wire(monkeypatch, tenants_repo, users_repo):
    settings = _auth_settings()
    monkeypatch.setattr(deps, "get_settings", lambda: settings)
    monkeypatch.setattr(routes_auth, "get_settings", lambda: settings)
    monkeypatch.setattr(routes_auth, "get_users_repository", lambda: users_repo)
    monkeypatch.setattr(routes_auth, "get_tenants_repository", lambda: tenants_repo)
    from app.core import auth_lockout
    auth_lockout.reset_for_tests()
    password_reset.reset_for_tests()
    from app.core.http_hardening import clear_rate_limits
    clear_rate_limits()
    yield
    password_reset.reset_for_tests()


def _signup(email: str, password: str = "hunter2hunter2") -> dict:
    r = client.post("/auth/signup", json={"email": email, "password": password})
    assert r.status_code == 201, r.text
    return r.json()


def test_forgot_password_unknown_email_is_neutral_200(captured_emails):
    r = client.post("/auth/forgot-password", json={"email": "nobody@example.com"})
    assert r.status_code == 200, r.text
    assert "reset link" in r.json()["message"].lower()
    # No email issued for an unknown address.
    assert captured_emails == []


def test_forgot_password_known_email_issues_reset_token(captured_emails):
    _signup("known@example.com")
    r = client.post("/auth/forgot-password", json={"email": "known@example.com"})
    assert r.status_code == 200, r.text
    assert len(captured_emails) == 1
    assert captured_emails[0]["to_email"] == "known@example.com"
    assert captured_emails[0]["raw_token"]


def test_forgot_password_response_identical_for_known_and_unknown(captured_emails):
    _signup("real@example.com")
    known = client.post("/auth/forgot-password", json={"email": "real@example.com"})
    unknown = client.post("/auth/forgot-password", json={"email": "ghost@example.com"})
    # Enumeration-safety: same status and same body either way.
    assert known.status_code == unknown.status_code == 200
    assert known.json() == unknown.json()


def test_reset_password_completes_and_signs_in(captured_emails):
    _signup("reset@example.com", password="oldpassword1")
    client.post("/auth/forgot-password", json={"email": "reset@example.com"})
    token = captured_emails[0]["raw_token"]

    r = client.post(
        "/auth/reset-password", json={"token": token, "password": "brandnewpass1"}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["token"] and body["refresh_token"]
    assert body["principal"]["email"] == "reset@example.com"

    # New password works; old one no longer does.
    assert client.post(
        "/auth/signin", json={"email": "reset@example.com", "password": "brandnewpass1"}
    ).status_code == 200
    assert client.post(
        "/auth/signin", json={"email": "reset@example.com", "password": "oldpassword1"}
    ).status_code == 401


def test_reset_token_is_single_use(captured_emails):
    _signup("once@example.com")
    client.post("/auth/forgot-password", json={"email": "once@example.com"})
    token = captured_emails[0]["raw_token"]

    first = client.post(
        "/auth/reset-password", json={"token": token, "password": "firstchange1"}
    )
    assert first.status_code == 200
    second = client.post(
        "/auth/reset-password", json={"token": token, "password": "secondchange1"}
    )
    assert second.status_code == 400


def test_reset_password_rejects_unknown_token():
    r = client.post(
        "/auth/reset-password", json={"token": "not-a-real-token", "password": "whatever12"}
    )
    assert r.status_code == 400
    assert "invalid" in r.json()["detail"].lower() or "expired" in r.json()["detail"].lower()


def test_reset_password_rejects_short_password(captured_emails):
    _signup("shorty@example.com")
    client.post("/auth/forgot-password", json={"email": "shorty@example.com"})
    token = captured_emails[0]["raw_token"]
    r = client.post("/auth/reset-password", json={"token": token, "password": "abc"})
    assert r.status_code == 422
