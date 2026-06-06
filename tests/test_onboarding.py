"""Individual/company onboarding, invitations, RBAC, and tenant isolation."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_onboarding
from app.core.audit import AuditLogger
from app.core.auth import hash_password
from app.db.assets_repository import LocalJsonAssetsRepository
from app.db.onboarding_repository import LocalJsonOnboardingRepository
from app.db.tenants_repository import LocalJsonTenantsRepository
from app.db.users_repository import LocalJsonUsersRepository
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


@pytest.fixture
def repos(tmp_path):
    tenants = LocalJsonTenantsRepository(tmp_path / "tenants.jsonl")
    users = LocalJsonUsersRepository(tmp_path / "users.jsonl")
    onboarding = LocalJsonOnboardingRepository(
        tmp_path / "onboarding.jsonl",
        tmp_path / "invitations.jsonl",
    )
    assets = LocalJsonAssetsRepository(
        tmp_path / "assets.jsonl",
        tmp_path / "relationships.jsonl",
    )
    tenants.create(
        id="tenant-a",
        name="Pending workspace",
        attributes={"account_type": "company", "onboarding_status": "in_progress"},
    )
    tenants.create(
        id="tenant-b",
        name="Other Company",
        attributes={"account_type": "company", "onboarding_status": "completed"},
    )
    owner = users.signup(
        tenant_id="tenant-a",
        email="owner@example.com",
        role="tenant_owner",
        password_hash=hash_password("correcthorse1"),
        id="owner",
    )
    users.signup(
        tenant_id="tenant-b",
        email="other@example.com",
        role="tenant_owner",
        password_hash=hash_password("correcthorse1"),
        id="other-owner",
    )
    return tenants, users, onboarding, assets, owner


@pytest.fixture(autouse=True)
def wire(monkeypatch, tmp_path, repos):
    tenants, users, onboarding, assets, _ = repos
    settings = SimpleNamespace(
        **jwt_settings().__dict__,
        invitation_expiry_days=7,
        invite_email_delivery_enabled=False,
        password_min_length=8,
    )
    monkeypatch.setattr(deps, "get_settings", lambda: settings)
    monkeypatch.setattr(routes_onboarding, "get_settings", lambda: settings)
    monkeypatch.setattr(routes_onboarding, "get_tenants_repository", lambda: tenants)
    monkeypatch.setattr(routes_onboarding, "get_users_repository", lambda: users)
    monkeypatch.setattr(routes_onboarding, "get_onboarding_repository", lambda: onboarding)
    monkeypatch.setattr(routes_onboarding, "get_assets_repository", lambda: assets)
    monkeypatch.setattr(
        routes_onboarding,
        "audit_logger",
        AuditLogger(tmp_path / "audit.jsonl"),
    )


def headers(*, tenant="tenant-a", user="owner", role="tenant_owner"):
    return auth_headers(
        tenant_id=tenant,
        user_id=user,
        role=role,
        allowed_assets=["*"],
    )


def company_payload():
    return {
        "company_name": "Delta Energy",
        "country_of_registration": "Nigeria",
        "primary_operating_country": "Nigeria",
        "company_type": "Upstream operator",
        "company_size": "51-200",
        "focus_areas": ["Emissions / ESG / MRV", "Research oil and gas topics"],
        "primary_jurisdiction": "Nigeria",
        "regulator_focus": ["NUPRC", "NCDMB"],
    }


def test_account_type_and_individual_onboarding_complete(repos):
    tenants, _, onboarding, _, _ = repos
    assert client.post(
        "/onboarding/account-type",
        headers=headers(),
        json={"account_type": "individual"},
    ).status_code == 200
    saved = client.post(
        "/onboarding/individual",
        headers=headers(),
        json={
            "full_name": "Ada Okafor",
            "country": "Nigeria",
            "focus_areas": ["Emissions / ESG / MRV"],
            "use_cases": ["Build GHG/MRV reports"],
            "preferred_jurisdiction": "Nigeria",
        },
    )
    assert saved.status_code == 200, saved.text
    complete = client.post(
        "/onboarding/complete",
        headers=headers(),
        json={"skipped_optional": True},
    )
    assert complete.status_code == 200
    assert complete.json()["recommended_destination"] == "/emissions"
    assert onboarding.get_profile(user_id="owner", tenant_id="tenant-a")["status"] == "completed"
    assert tenants.get("tenant-a")["attributes"]["onboarding_status"] == "completed"


def test_company_onboarding_creates_governed_workspace_defaults(repos):
    tenants, users, _, _, _ = repos
    response = client.post(
        "/onboarding/company",
        headers=headers(),
        json=company_payload(),
    )
    assert response.status_code == 200, response.text
    organization = response.json()["organization"]
    assert organization["company_name"] == "Delta Energy"
    assert organization["audit_settings"]["enabled"] is True
    assert organization["safety_settings"]["bypass_escalation"] is True
    assert "Admin / Audit" in organization["default_folders"]
    assert "nuprc.gov.ng" in organization["source_preferences"]
    assert users.get(tenant_id="tenant-a", user_id="owner")["role"] == "tenant_owner"
    assert tenants.get("tenant-a")["name"] == "Delta Energy"


def test_company_onboarding_adds_tenant_scoped_asset(repos):
    _, _, _, assets, _ = repos
    response = client.post(
        "/onboarding/company/assets",
        headers=headers(),
        json={
            "asset_name": "Oloibiri Field",
            "asset_type": "Field",
            "country": "Nigeria",
            "basin": "Niger Delta",
        },
    )
    assert response.status_code == 201
    assert response.json()["tenant_id"] == "tenant-a"
    assert assets.list_records(tenant_id="tenant-b") == []


def test_invitation_is_hashed_and_delivery_is_truthful(repos):
    _, _, onboarding, _, _ = repos
    response = client.post(
        "/organizations/current/invitations",
        headers=headers(),
        json={
            "email": "engineer@example.com",
            "role": "engineer",
            "department": "Operations",
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["delivery"]["email_sent"] is False
    assert "not enabled" in body["delivery"]["message"]
    assert body["invite_token"]
    stored = onboarding.list_invitations(tenant_id="tenant-a")[0]
    assert stored["invite_token_hash"] != body["invite_token"]
    assert len(stored["invite_token_hash"]) == 64


def test_invitation_email_sent_when_delivery_configured(repos, monkeypatch):
    sent: dict = {}

    def fake_send(**kwargs):
        sent.update(kwargs)
        return {"email_sent": True, "message": f"Invitation email sent to {kwargs['to_email']}."}

    monkeypatch.setattr(routes_onboarding, "send_invitation_email", fake_send)
    response = client.post(
        "/organizations/current/invitations",
        headers=headers(),
        json={"email": "newhire@example.com", "role": "engineer", "department": "Operations"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["delivery"]["email_sent"] is True
    assert "newhire@example.com" in body["delivery"]["message"]
    assert sent["to_email"] == "newhire@example.com"
    assert sent["company_name"] == "Pending workspace"
    assert sent["role_label"] == "Engineer"
    assert sent["raw_token"]


def test_invitation_acceptance_creates_membership(repos):
    _, users, _, _, _ = repos
    created = client.post(
        "/organizations/current/invitations",
        headers=headers(),
        json={"email": "new@example.com", "role": "hse_manager"},
    ).json()
    accepted = client.post(
        "/invitations/accept",
        json={"token": created["invite_token"], "password": "correcthorse1"},
    )
    assert accepted.status_code == 201, accepted.text
    user = users.get_by_email(tenant_id="tenant-a", email="new@example.com")
    assert user["role"] == "hse_manager"
    assert user["status"] == "active"


def test_expired_and_revoked_invitations_cannot_be_accepted(repos):
    _, _, onboarding, _, _ = repos
    expired, expired_token = onboarding.create_invitation(
        tenant_id="tenant-a",
        email="expired@example.com",
        role="engineer",
        department=None,
        message=None,
        invited_by_user_id="owner",
        expiry_days=7,
    )
    onboarding.update_invitation(
        tenant_id="tenant-a",
        invitation_id=expired["invitation_id"],
        changes={"expires_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()},
    )
    expired_response = client.post(
        "/invitations/accept",
        json={"token": expired_token, "password": "correcthorse1"},
    )
    assert expired_response.status_code == 410

    revoked, revoked_token = onboarding.create_invitation(
        tenant_id="tenant-a",
        email="revoked@example.com",
        role="engineer",
        department=None,
        message=None,
        invited_by_user_id="owner",
        expiry_days=7,
    )
    onboarding.update_invitation(
        tenant_id="tenant-a",
        invitation_id=revoked["invitation_id"],
        changes={"status": "revoked"},
    )
    revoked_response = client.post(
        "/invitations/accept",
        json={"token": revoked_token, "password": "correcthorse1"},
    )
    assert revoked_response.status_code == 404


def test_viewer_cannot_invite_and_other_tenant_is_not_visible():
    denied = client.post(
        "/organizations/current/invitations",
        headers=headers(user="viewer", role="viewer"),
        json={"email": "x@example.com", "role": "engineer"},
    )
    assert denied.status_code == 403
    current = client.get("/organizations/current", headers=headers())
    assert current.json()["tenant_id"] == "tenant-a"
    members = client.get("/organizations/current/members", headers=headers())
    assert all(row["tenant_id"] == "tenant-a" for row in members.json()["members"])


def test_company_admin_can_change_member_role(repos):
    _, users, _, _, _ = repos
    member = users.signup(
        tenant_id="tenant-a",
        email="member@example.com",
        role="viewer",
        password_hash=hash_password("correcthorse1"),
    )
    response = client.patch(
        f"/admin/company/members/{member.id}",
        headers=headers(),
        json={"role": "emissions_lead"},
    )
    assert response.status_code == 200
    assert response.json()["role"] == "emissions_lead"
