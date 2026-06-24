"""Two-factor (TOTP) flow tests for /auth: enrollment, code login, recovery
codes, enforcement, and lockout."""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pyotp
import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_auth
from app.db.tenants_repository import LocalJsonTenantsRepository
from app.db.users_repository import LocalJsonUsersRepository
from app.main import app
from tests.auth_helpers import JWT_AUDIENCE, JWT_ISSUER, JWT_SECRET


client = TestClient(app)


def _settings(**overrides):
    base = {
        "jwt_secret": JWT_SECRET,
        "jwt_public_key": "",
        "jwt_issuer": JWT_ISSUER,
        "jwt_audience": JWT_AUDIENCE,
        "jwt_ttl_hours": 1,
        "refresh_token_ttl_days": 14,
        "enable_self_signup": True,
        "default_signup_tenant_id": "demo",
        "default_signup_role": "engineer",
        "password_min_length": 8,
        "require_2fa": False,
        "mfa_challenge_ttl_minutes": 10,
        "totp_issuer": "PetroBrain",
    }
    base.update(overrides)
    return SimpleNamespace(**base)


@pytest.fixture
def users_repo(tmp_path):
    return LocalJsonUsersRepository(tmp_path / "users.jsonl")


@pytest.fixture
def tenants_repo(tmp_path):
    return LocalJsonTenantsRepository(tmp_path / "tenants.jsonl")


# Mutable holder so individual tests can flip require_2fa for the same wiring.
_STATE: dict = {}


@pytest.fixture(autouse=True)
def wire(monkeypatch, users_repo, tenants_repo):
    _STATE["require_2fa"] = False

    def current_settings():
        return _settings(require_2fa=_STATE["require_2fa"])

    monkeypatch.setattr(deps, "get_settings", current_settings)
    monkeypatch.setattr(routes_auth, "get_settings", current_settings)
    monkeypatch.setattr(routes_auth, "get_users_repository", lambda: users_repo)
    monkeypatch.setattr(routes_auth, "get_tenants_repository", lambda: tenants_repo)
    from app.core import auth_lockout
    auth_lockout.reset_for_tests()
    from app.core.http_hardening import clear_rate_limits
    clear_rate_limits()


def _code_for(secret: str) -> str:
    return pyotp.TOTP(secret).now()


def _signup(email="user@example.com", password="correcthorse1"):
    return client.post("/auth/signup", json={"email": email, "password": password})


def test_enrollment_completes_and_returns_recovery_codes_and_session():
    _STATE["require_2fa"] = True
    # Signup now returns a challenge instead of a session.
    s = _signup()
    assert s.status_code == 201, s.text
    body = s.json()
    assert body["mfa_required"] is True
    assert body["enrolled"] is False
    mfa_token = body["mfa_token"]
    assert "token" not in body  # no session issued yet

    # Enroll -> get a secret + otpauth URI.
    enroll = client.post("/auth/2fa/enroll", json={"mfa_token": mfa_token})
    assert enroll.status_code == 200, enroll.text
    secret = enroll.json()["secret"]
    assert enroll.json()["otpauth_uri"].startswith("otpauth://totp/")

    # Verify with a real code -> full session + one-time recovery codes.
    verify = client.post(
        "/auth/2fa/verify", json={"mfa_token": mfa_token, "code": _code_for(secret)}
    )
    assert verify.status_code == 200, verify.text
    vb = verify.json()
    assert vb["token"]
    assert vb["refresh_token"]
    assert isinstance(vb["recovery_codes"], list) and len(vb["recovery_codes"]) == 10
    # The session token works against a protected route (decodes to a principal).
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {vb['token']}"})
    assert me.status_code == 200


def test_enrolled_user_is_challenged_on_signin_and_logs_in_with_code():
    _STATE["require_2fa"] = True
    # Enroll first.
    mfa_token = _signup("bob@example.com").json()["mfa_token"]
    secret = client.post("/auth/2fa/enroll", json={"mfa_token": mfa_token}).json()["secret"]
    client.post("/auth/2fa/verify", json={"mfa_token": mfa_token, "code": _code_for(secret)})

    # Now sign in: password is right but a session is NOT issued; a challenge is.
    signin = client.post(
        "/auth/signin", json={"email": "bob@example.com", "password": "correcthorse1"}
    )
    assert signin.status_code == 200, signin.text
    sb = signin.json()
    assert sb["mfa_required"] is True
    assert sb["enrolled"] is True
    assert "token" not in sb

    verify = client.post(
        "/auth/2fa/verify",
        json={"mfa_token": sb["mfa_token"], "code": _code_for(secret)},
    )
    assert verify.status_code == 200
    assert verify.json()["token"]


def test_enrolled_user_is_challenged_even_when_flag_off():
    # Enroll while required.
    _STATE["require_2fa"] = True
    mfa_token = _signup("carol@example.com").json()["mfa_token"]
    secret = client.post("/auth/2fa/enroll", json={"mfa_token": mfa_token}).json()["secret"]
    client.post("/auth/2fa/verify", json={"mfa_token": mfa_token, "code": _code_for(secret)})

    # Turn the global flag off: an already-enrolled user must still pass 2FA.
    _STATE["require_2fa"] = False
    signin = client.post(
        "/auth/signin", json={"email": "carol@example.com", "password": "correcthorse1"}
    )
    assert signin.json().get("mfa_required") is True
    assert signin.json()["enrolled"] is True


def test_recovery_code_logs_in_and_is_single_use():
    _STATE["require_2fa"] = True
    mfa_token = _signup("dave@example.com").json()["mfa_token"]
    secret = client.post("/auth/2fa/enroll", json={"mfa_token": mfa_token}).json()["secret"]
    codes = client.post(
        "/auth/2fa/verify", json={"mfa_token": mfa_token, "code": _code_for(secret)}
    ).json()["recovery_codes"]
    one = codes[0]

    # Sign in and use a recovery code instead of a TOTP.
    ch = client.post(
        "/auth/signin", json={"email": "dave@example.com", "password": "correcthorse1"}
    ).json()["mfa_token"]
    r1 = client.post("/auth/2fa/verify", json={"mfa_token": ch, "code": one})
    assert r1.status_code == 200, r1.text

    # The same recovery code cannot be reused.
    ch2 = client.post(
        "/auth/signin", json={"email": "dave@example.com", "password": "correcthorse1"}
    ).json()["mfa_token"]
    r2 = client.post("/auth/2fa/verify", json={"mfa_token": ch2, "code": one})
    assert r2.status_code == 401


def test_wrong_code_is_rejected():
    _STATE["require_2fa"] = True
    mfa_token = _signup("erin@example.com").json()["mfa_token"]
    client.post("/auth/2fa/enroll", json={"mfa_token": mfa_token})
    bad = client.post(
        "/auth/2fa/verify", json={"mfa_token": mfa_token, "code": "000000"}
    )
    assert bad.status_code == 401


def test_challenge_token_cannot_be_used_as_a_session_token():
    _STATE["require_2fa"] = True
    mfa_token = _signup("mallory@example.com").json()["mfa_token"]
    # The challenge token must NOT authenticate against a protected route.
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {mfa_token}"})
    assert me.status_code == 401


def test_signin_without_2fa_is_unchanged_when_flag_off():
    _STATE["require_2fa"] = False
    _signup("frank@example.com")
    r = client.post(
        "/auth/signin", json={"email": "frank@example.com", "password": "correcthorse1"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["token"]
    assert "mfa_required" not in body
