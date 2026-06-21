"""JWT auth and RBAC tests."""
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.api import deps
from app.api.deps import Principal, require_role
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings, mint_token


client = TestClient(app)


def document_payload():
    return {
        "filename": "sop.md",
        "document_id": "SOP-001",
        "title": "Kick Detection SOP",
        "revision": "Rev 1",
        "jurisdiction": "Nigeria",
        "asset": "Asset-A",
        "document_type": "sop",
        "text": "# 1 Purpose\nDetect kicks early.",
    }


@pytest.fixture(autouse=True)
def use_jwt_settings(monkeypatch):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)


def test_valid_jwt_allows_request():
    r = client.post(
        "/documents/preview",
        headers=auth_headers(tenant_id="tenant-a", allowed_assets=["Asset-A"]),
        json=document_payload(),
    )

    assert r.status_code == 200
    assert r.json()["chunks"][0]["metadata"]["tenant_id"] == "tenant-a"


def test_expired_jwt_is_rejected():
    token = mint_token(expires_delta=timedelta(seconds=-1))

    r = client.post(
        "/documents/preview",
        headers={"Authorization": f"Bearer {token}"},
        json=document_payload(),
    )

    assert r.status_code == 401
    assert r.json()["detail"] == "token expired"


def test_missing_token_is_rejected():
    r = client.post("/documents/preview", json=document_payload())

    assert r.status_code == 401
    assert r.json()["detail"] == "missing credentials"


def test_wrong_signature_is_rejected():
    token = mint_token(secret="wrong-secret-change-me-32-bytes-minimum")

    r = client.post(
        "/documents/preview",
        headers={"Authorization": f"Bearer {token}"},
        json=document_payload(),
    )

    assert r.status_code == 401
    assert r.json()["detail"] == "invalid credentials"


def test_role_mismatch_is_rejected():
    checker = require_role("admin")
    principal = Principal(
        tenant_id="tenant-a",
        user_id="u1",
        role="engineer",
        allowed_assets=["Asset-A"],
    )

    with pytest.raises(HTTPException) as exc:
        checker(principal)

    assert exc.value.status_code == 403
    assert exc.value.detail == "role not allowed for principal"


def test_current_principal_returns_authoritative_role_and_tenant():
    response = client.get(
        "/auth/me",
        headers=auth_headers(
            tenant_id="tenant-a",
            user_id="u-rbac",
            role="hse_manager",
            allowed_assets=["Asset-A"],
        ),
    )

    assert response.status_code == 200
    assert response.json() == {
        "user_id": "u-rbac",
        "tenant_id": "tenant-a",
        "role": "hse_manager",
        "allowed_assets": ["Asset-A"],
        "email": None,
    }
