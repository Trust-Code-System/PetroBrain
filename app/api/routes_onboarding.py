"""Self-serve individual/company onboarding and tenant-safe team administration."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.api.deps import (
    Principal,
    get_principal,
    is_tenant_admin,
)
from app.config import get_settings
from app.core.audit import AuditEvent, get_audit_logger
from app.core.auth import hash_password
from app.core.email import email_delivery_active, send_invitation_email
from app.db.assets_repository import get_assets_repository
from app.db.onboarding_repository import (
    get_onboarding_repository,
    invitation_is_expired,
)
from app.db.tenants_repository import get_tenants_repository
from app.db.users_repository import get_users_repository


onboarding_router = APIRouter(prefix="/onboarding", tags=["onboarding"])
organizations_router = APIRouter(prefix="/organizations", tags=["organizations"])
invitations_router = APIRouter(prefix="/invitations", tags=["invitations"])
company_admin_router = APIRouter(prefix="/admin/company", tags=["admin", "company"])
audit_logger = get_audit_logger()

ACCOUNT_TYPES = {"individual", "company"}
INVITABLE_ROLES = {
    "company_admin",
    "compliance_admin",
    "hse_manager",
    "emissions_lead",
    "engineer",
    "field_supervisor",
    "operations_user",
    "commercial_user",
    "procurement_user",
    "auditor",
    "viewer",
}
DEFAULT_FOLDERS = [
    "Research",
    "Documents",
    "Emissions / MRV",
    "HSE / PTW",
    "Regulatory Compliance",
    "Production / Operations",
    "Drilling / Well Control",
    "Facilities",
    "Procurement / Contracts",
    "Commercial / Investment",
    "Admin / Audit",
]

FOCUS_AREAS = [
    "Upstream", "Drilling / Well Control", "Production", "Reservoir",
    "Facilities / Operations", "HSE / Safety", "Emissions / ESG / MRV",
    "Regulatory / Compliance", "Commercial / Trading", "Procurement / Contracts",
    "Midstream / Downstream", "Finance / Investment",
    "Software / AI / Digital Oilfield", "Student / Researcher", "Other",
]
USE_CASES = [
    "Research oil and gas topics", "Analyze documents", "Create reports and memos",
    "Run emissions calculations", "Build GHG/MRV reports", "Create PTW/HSE drafts",
    "Understand well control concepts", "Analyze production data", "Track regulations",
    "Build oil and gas software", "Prepare investment/commercial analysis",
    "Learn oil and gas concepts",
]
REGIONS = [
    "Nigeria", "Ghana", "West Africa", "Africa", "Middle East",
    "North America", "Europe", "Global", "Other",
]
COMPANY_TYPES = [
    "Upstream operator", "Marginal field operator", "National oil company",
    "International oil company", "Oilfield service company", "EPC company",
    "Drilling contractor", "FPSO / marine contractor", "Pipeline / midstream company",
    "Gas processing company", "LNG company", "Refinery / downstream company",
    "Trading company", "Consulting company", "Regulator / government agency",
    "Finance / investment firm", "Law / compliance advisory",
    "Software / technology company", "Training / education provider", "Other",
]
REGULATORS = [
    "NUPRC", "NMDPRA", "NCDMB", "Ministry of Petroleum Resources",
    "EPA / environmental regulator", "OGMP 2.0", "ISO 14064-1",
    "Internal company standards", "Other",
]


class AccountTypeRequest(BaseModel):
    account_type: Literal["individual", "company"]


class IndividualOnboardingRequest(BaseModel):
    full_name: str = Field(min_length=2, max_length=160)
    job_title: str | None = Field(default=None, max_length=160)
    country: str = Field(min_length=2, max_length=100)
    timezone: str = Field(default="Africa/Lagos", max_length=80)
    focus_areas: list[str] = Field(default_factory=list)
    use_cases: list[str] = Field(default_factory=list)
    preferred_jurisdiction: str | None = Field(default=None, max_length=100)
    current_step: str = "region"


class CompanyOnboardingRequest(BaseModel):
    company_name: str = Field(min_length=2, max_length=200)
    company_website: str | None = Field(default=None, max_length=300)
    company_email_domain: str | None = Field(default=None, max_length=160)
    country_of_registration: str = Field(min_length=2, max_length=100)
    primary_operating_country: str = Field(min_length=2, max_length=100)
    company_type: str
    company_size: str
    focus_areas: list[str] = Field(default_factory=list)
    primary_jurisdiction: str | None = None
    secondary_jurisdictions: list[str] = Field(default_factory=list)
    regulator_focus: list[str] = Field(default_factory=list)
    current_step: str = "assets"


class OnboardingAssetRequest(BaseModel):
    asset_name: str = Field(min_length=2, max_length=200)
    asset_type: str
    country: str | None = None
    basin: str | None = None
    field: str | None = None
    facility_type: str | None = None
    notes: str | None = Field(default=None, max_length=1000)


class CompleteOnboardingRequest(BaseModel):
    skipped_optional: bool = False


class OrganizationCreateRequest(CompanyOnboardingRequest):
    company_slug: str | None = None


class OrganizationUpdateRequest(BaseModel):
    company_name: str | None = None
    company_website: str | None = None
    company_email_domain: str | None = None
    country_of_registration: str | None = None
    primary_operating_country: str | None = None
    company_type: str | None = None
    company_size: str | None = None
    focus_areas: list[str] | None = None
    primary_jurisdiction: str | None = None
    secondary_jurisdictions: list[str] | None = None
    regulator_focus: list[str] | None = None


class InvitationCreateRequest(BaseModel):
    email: str
    role: str
    department: str | None = Field(default=None, max_length=120)
    message: str | None = Field(default=None, max_length=1000)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", cleaned):
            raise ValueError("not a valid email address")
        return cleaned

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        if value not in INVITABLE_ROLES:
            raise ValueError("role is not available for organization invitations")
        return value


class InvitationUpdateRequest(BaseModel):
    role: str | None = None
    department: str | None = None
    action: Literal["update", "resend", "revoke"] = "update"


class InvitationAcceptRequest(BaseModel):
    token: str = Field(min_length=20)
    password: str = Field(min_length=8)


class MemberUpdateRequest(BaseModel):
    role: str

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        if value not in INVITABLE_ROLES | {"tenant_owner"}:
            raise ValueError("unknown organization role")
        return value


@onboarding_router.get("/options")
async def onboarding_options():
    return {
        "account_types": ["individual", "company"],
        "focus_areas": FOCUS_AREAS,
        "use_cases": USE_CASES,
        "regions": REGIONS,
        "company_types": COMPANY_TYPES,
        "company_sizes": ["1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"],
        "regulator_focus": REGULATORS,
        "asset_types": [
            "Field", "Block / license", "Well", "Flowstation", "FPSO", "Terminal",
            "Pipeline", "Refinery", "Gas plant", "LNG facility", "Depot",
            "Office / corporate", "Other",
        ],
        "roles": sorted(INVITABLE_ROLES),
    }


@onboarding_router.get("/status")
async def onboarding_status(who: Principal = Depends(get_principal)):
    profile = _onboarding().get_profile(user_id=who.user_id, tenant_id=who.tenant_id)
    tenant = _tenant_or_404(who.tenant_id)
    attrs = tenant.get("attributes") or {}
    return {
        "account_type": (profile or {}).get("account_type") or attrs.get("account_type"),
        "onboarding_status": (profile or {}).get("status") or attrs.get(
            "onboarding_status", "not_started"
        ),
        "current_step": (profile or {}).get("current_step", "account_type"),
        "answers": (profile or {}).get("answers", {}),
        "tenant_id": who.tenant_id,
        "workspace_name": tenant["name"],
    }


@onboarding_router.post("/account-type")
async def select_account_type(
    req: AccountTypeRequest, who: Principal = Depends(get_principal)
):
    record = _save_profile(
        who, req.account_type, "profile", {"account_type": req.account_type}
    )
    _merge_tenant_attributes(
        who.tenant_id,
        {"account_type": req.account_type, "workspace_type": req.account_type,
         "onboarding_status": "in_progress"},
    )
    _audit("account_type_selected", who, req.model_dump(), record)
    return record


@onboarding_router.post("/individual")
async def save_individual(
    req: IndividualOnboardingRequest, who: Principal = Depends(get_principal)
):
    answers = req.model_dump()
    record = _save_profile(who, "individual", req.current_step, answers)
    defaults = _workspace_defaults("individual", req.focus_areas, req.preferred_jurisdiction)
    _update_tenant(
        who.tenant_id,
        name=f"{req.full_name}'s workspace",
        attributes={
            "account_type": "individual",
            "workspace_type": "individual",
            "profile": answers,
            **defaults,
        },
    )
    _audit("individual_onboarding_saved", who, answers, record)
    return {"profile": record, "workspace_defaults": defaults}


@onboarding_router.post("/company")
async def save_company(
    req: CompanyOnboardingRequest, who: Principal = Depends(get_principal)
):
    answers = req.model_dump()
    slug = _slug(req.company_name)
    defaults = _workspace_defaults("company", req.focus_areas, req.primary_jurisdiction)
    attrs = {
        **answers,
        "account_type": "company",
        "workspace_type": "company",
        "company_slug": slug,
        "created_by_user_id": who.user_id,
        "default_folders": DEFAULT_FOLDERS,
        "audit_settings": {"enabled": True, "hash_chain": True},
        "safety_settings": {"bypass_escalation": True, "human_verification": True},
        "source_governance": {"prefer_official": True, "weak_source_labels": True},
        "memory_space": {"tenant_scoped": True, "enabled": True},
        **defaults,
    }
    _update_tenant(who.tenant_id, name=req.company_name, attributes=attrs)
    record = _save_profile(who, "company", req.current_step, answers)
    _audit("company_onboarding_saved", who, answers, record)
    return {"organization": _public_organization(_tenant_or_404(who.tenant_id)), "profile": record}


@onboarding_router.post("/company/assets", status_code=201)
async def add_company_asset(
    req: OnboardingAssetRequest, who: Principal = Depends(get_principal)
):
    record = get_assets_repository().create(
        tenant_id=who.tenant_id,
        type=req.asset_type.lower().replace(" / ", "_").replace(" ", "_"),
        name=req.asset_name,
        attributes={
            key: value for key, value in req.model_dump().items()
            if key not in {"asset_name", "asset_type"} and value
        },
    )
    payload = record.as_dict()
    _audit("asset_created_during_onboarding", who, req.model_dump(), payload)
    return payload


@onboarding_router.post("/complete")
async def complete_onboarding(
    req: CompleteOnboardingRequest, who: Principal = Depends(get_principal)
):
    current = _onboarding().get_profile(user_id=who.user_id, tenant_id=who.tenant_id)
    if not current:
        raise HTTPException(status_code=422, detail="complete at least the required onboarding fields")
    answers = current.get("answers") or {}
    account_type = current["account_type"]
    required = ["full_name", "country"] if account_type == "individual" else [
        "company_name", "country_of_registration", "primary_operating_country",
        "company_type", "company_size",
    ]
    missing = [key for key in required if not answers.get(key)]
    if missing:
        raise HTTPException(status_code=422, detail=f"missing required fields: {', '.join(missing)}")
    record = _onboarding().save_profile(
        user_id=who.user_id,
        tenant_id=who.tenant_id,
        account_type=account_type,
        current_step="done",
        answers={"skipped_optional": req.skipped_optional},
        status="completed",
    )
    _merge_tenant_attributes(
        who.tenant_id,
        {"onboarding_status": "completed", "onboarding_completed_at": _now()},
    )
    destination = _recommended_destination(answers, account_type)
    _audit(
        "onboarding_completed", who, req.model_dump(),
        {"destination": destination, "account_type": account_type},
    )
    return {
        "status": "completed",
        "account_type": account_type,
        "recommended_destination": destination,
        "profile": record,
    }


@organizations_router.post("", status_code=201)
async def create_organization(
    req: OrganizationCreateRequest, who: Principal = Depends(get_principal)
):
    return await save_company(CompanyOnboardingRequest(**req.model_dump()), who)


@organizations_router.get("/current")
async def current_organization(who: Principal = Depends(get_principal)):
    return _public_organization(_tenant_or_404(who.tenant_id))


@organizations_router.patch("/current")
async def update_organization(
    req: OrganizationUpdateRequest, who: Principal = Depends(get_principal)
):
    _require_company_admin(who)
    changes = {key: value for key, value in req.model_dump().items() if value is not None}
    tenant = _tenant_or_404(who.tenant_id)
    attrs = {**(tenant.get("attributes") or {}), **changes}
    name = changes.get("company_name") or tenant["name"]
    updated = _update_tenant(who.tenant_id, name=name, attributes=attrs)
    _audit("company_settings_updated", who, changes, updated)
    return _public_organization(updated)


@organizations_router.get("/current/members")
async def current_members(who: Principal = Depends(get_principal)):
    _require_company_admin(who, allow_auditor=True)
    return {"members": _users().list_records(tenant_id=who.tenant_id)}


@organizations_router.post("/current/invitations", status_code=201)
async def create_invitation(
    req: InvitationCreateRequest, who: Principal = Depends(get_principal)
):
    _require_company_admin(who)
    try:
        record, raw_token = _onboarding().create_invitation(
            tenant_id=who.tenant_id,
            email=req.email,
            role=req.role,
            department=req.department,
            message=req.message,
            invited_by_user_id=who.user_id,
            expiry_days=get_settings().invitation_expiry_days,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    delivery = _deliver_invitation(
        tenant_id=who.tenant_id,
        email=req.email,
        role=req.role,
        raw_token=raw_token,
        expires_at=record.get("expires_at"),
        message=req.message,
    )
    response = _invitation_response(record, raw_token, delivery)
    _audit("invitation_created", who, req.model_dump(), response)
    return response


@organizations_router.get("/current/invitations")
async def list_invitations(who: Principal = Depends(get_principal)):
    _require_company_admin(who, allow_auditor=True)
    return {
        "invitations": [
            _invitation_response(record) for record in
            _onboarding().list_invitations(tenant_id=who.tenant_id)
        ]
    }


@organizations_router.patch("/current/invitations/{invitation_id}")
async def update_invitation(
    invitation_id: str,
    req: InvitationUpdateRequest,
    who: Principal = Depends(get_principal),
):
    _require_company_admin(who)
    existing = _onboarding().get_invitation(
        tenant_id=who.tenant_id, invitation_id=invitation_id
    )
    if not existing:
        raise HTTPException(status_code=404, detail="invitation not found")
    if existing["status"] != "pending":
        raise HTTPException(status_code=409, detail="only pending invitations can be changed")
    if req.action == "revoke":
        updated = _onboarding().update_invitation(
            tenant_id=who.tenant_id,
            invitation_id=invitation_id,
            changes={"status": "revoked"},
        )
        _audit("invitation_revoked", who, {"invitation_id": invitation_id}, updated)
        return _invitation_response(updated)
    if req.action == "resend":
        _onboarding().update_invitation(
            tenant_id=who.tenant_id,
            invitation_id=invitation_id,
            changes={"status": "revoked"},
        )
        replacement, token = _onboarding().create_invitation(
            tenant_id=who.tenant_id,
            email=existing["email"],
            role=req.role or existing["role"],
            department=req.department or existing.get("department"),
            message=existing.get("message"),
            invited_by_user_id=who.user_id,
            expiry_days=get_settings().invitation_expiry_days,
        )
        delivery = _deliver_invitation(
            tenant_id=who.tenant_id,
            email=existing["email"],
            role=req.role or existing["role"],
            raw_token=token,
            expires_at=replacement.get("expires_at"),
            message=existing.get("message"),
        )
        response = _invitation_response(replacement, token, delivery)
        _audit("invitation_resent", who, {"invitation_id": invitation_id}, response)
        return response
    changes = {
        key: value for key, value in {"role": req.role, "department": req.department}.items()
        if value is not None
    }
    updated = _onboarding().update_invitation(
        tenant_id=who.tenant_id, invitation_id=invitation_id, changes=changes
    )
    return _invitation_response(updated)


@organizations_router.delete("/current/invitations/{invitation_id}", status_code=204)
async def revoke_invitation(
    invitation_id: str, who: Principal = Depends(get_principal)
):
    _require_company_admin(who)
    updated = _onboarding().update_invitation(
        tenant_id=who.tenant_id,
        invitation_id=invitation_id,
        changes={"status": "revoked"},
    )
    _audit("invitation_revoked", who, {"invitation_id": invitation_id}, updated)


@invitations_router.get("/{token}")
async def invitation_details(token: str):
    record = _valid_invitation(token)
    tenant = _tenant_or_404(record["tenant_id"])
    return {
        "company_name": tenant["name"],
        "email": record["email"],
        "role": record["role"],
        "department": record.get("department"),
        "expires_at": record["expires_at"],
    }


@invitations_router.post("/accept", status_code=201)
async def accept_invitation(req: InvitationAcceptRequest):
    record = _valid_invitation(req.token)
    settings = get_settings()
    if len(req.password) < settings.password_min_length:
        raise HTTPException(
            status_code=422,
            detail=f"password must be at least {settings.password_min_length} characters",
        )
    users = _users()
    if users.find_by_email_any_tenant(record["email"]):
        raise HTTPException(
            status_code=409,
            detail="this email already belongs to a PetroBrain workspace",
        )
    user = users.signup(
        tenant_id=record["tenant_id"],
        email=record["email"],
        role=record["role"],
        password_hash=hash_password(req.password),
    ).as_dict()
    updated = _onboarding().update_invitation(
        tenant_id=record["tenant_id"],
        invitation_id=record["invitation_id"],
        changes={"status": "accepted", "accepted_at": _now()},
    )
    _audit_for_record("invitation_accepted", user, {"invitation_id": record["invitation_id"]}, updated)
    return {"status": "accepted", "tenant_id": record["tenant_id"], "user_id": user["id"]}


@company_admin_router.get("/profile")
async def admin_company_profile(who: Principal = Depends(get_principal)):
    _require_company_admin(who, allow_auditor=True)
    return _public_organization(_tenant_or_404(who.tenant_id))


@company_admin_router.patch("/profile")
async def admin_update_company_profile(
    req: OrganizationUpdateRequest, who: Principal = Depends(get_principal)
):
    return await update_organization(req, who)


@company_admin_router.get("/members")
async def admin_members(who: Principal = Depends(get_principal)):
    return await current_members(who)


@company_admin_router.patch("/members/{member_id}")
async def update_member(
    member_id: str, req: MemberUpdateRequest, who: Principal = Depends(get_principal)
):
    _require_company_admin(who)
    existing = _users().get(tenant_id=who.tenant_id, user_id=member_id)
    if not existing:
        raise HTTPException(status_code=404, detail="member not found")
    if existing["role"] == "tenant_owner" and member_id != who.user_id:
        raise HTTPException(status_code=403, detail="tenant owner role cannot be reassigned")
    updated = _users().set_role(
        tenant_id=who.tenant_id, user_id=member_id, role=req.role
    )
    _audit("member_role_changed", who, {"member_id": member_id, "role": req.role}, updated)
    return updated


@company_admin_router.delete("/members/{member_id}", status_code=204)
async def remove_member(member_id: str, who: Principal = Depends(get_principal)):
    _require_company_admin(who)
    if member_id == who.user_id:
        raise HTTPException(status_code=422, detail="you cannot remove your own membership")
    existing = _users().get(tenant_id=who.tenant_id, user_id=member_id)
    if not existing:
        raise HTTPException(status_code=404, detail="member not found")
    if existing["role"] == "tenant_owner":
        raise HTTPException(status_code=403, detail="tenant owner cannot be removed")
    updated = _users().set_status(
        tenant_id=who.tenant_id, user_id=member_id, status="deactivated"
    )
    _audit("member_removed", who, {"member_id": member_id}, updated)


def _require_company_admin(who: Principal, *, allow_auditor: bool = False) -> None:
    if who.role == "platform_admin" or is_tenant_admin(who):
        return
    if allow_auditor and who.role == "auditor":
        return
    raise HTTPException(status_code=403, detail="company admin role required")


def _save_profile(
    who: Principal, account_type: str, current_step: str, answers: dict[str, Any]
) -> dict[str, Any]:
    return _onboarding().save_profile(
        user_id=who.user_id,
        tenant_id=who.tenant_id,
        account_type=account_type,
        current_step=current_step,
        answers=answers,
    )


def _workspace_defaults(
    account_type: str, focus_areas: list[str], jurisdiction: str | None
) -> dict[str, Any]:
    lowered = " ".join(focus_areas).lower()
    modules = ["general", "research", "documents"]
    if "emission" in lowered or "mrv" in lowered or "esg" in lowered:
        modules.append("emissions_mrv")
    if "hse" in lowered or "safety" in lowered:
        modules.append("ptw")
    if "drilling" in lowered or "well control" in lowered:
        modules.append("well_control")
    source_preferences = ["official", "primary"]
    if (jurisdiction or "").lower() == "nigeria":
        source_preferences.extend(["nuprc.gov.ng", "nmdpra.gov.ng", "ncdmb.gov.ng"])
    return {
        "default_modules": list(dict.fromkeys(modules)),
        "default_jurisdiction": jurisdiction,
        "source_preferences": source_preferences,
        "memory_preferences": {"enabled": True, "tenant_scoped": True},
        "workspace_type": account_type,
    }


def _recommended_destination(answers: dict[str, Any], account_type: str) -> str:
    if account_type == "company":
        return "/admin/company"
    text = " ".join(answers.get("focus_areas", []) + answers.get("use_cases", [])).lower()
    if "emission" in text or "mrv" in text or "ghg" in text:
        return "/emissions"
    if "hse" in text or "ptw" in text or "safety" in text:
        return "/chat?module=ptw"
    if "research" in text or "regulation" in text or "investment" in text:
        return "/research"
    return "/chat"


def _valid_invitation(token: str) -> dict[str, Any]:
    record = _onboarding().find_by_token(token)
    if not record or record["status"] != "pending":
        raise HTTPException(status_code=404, detail="invitation is invalid or no longer active")
    if invitation_is_expired(record):
        _onboarding().update_invitation(
            tenant_id=record["tenant_id"],
            invitation_id=record["invitation_id"],
            changes={"status": "expired"},
        )
        raise HTTPException(status_code=410, detail="invitation has expired")
    return record


def _invitation_response(
    record: dict[str, Any],
    raw_token: str | None = None,
    delivery: dict[str, Any] | None = None,
) -> dict[str, Any]:
    response = {
        key: value for key, value in record.items() if key != "invite_token_hash"
    }
    if delivery is not None:
        response["delivery"] = delivery
    else:
        response["delivery"] = {
            "email_sent": False,
            "message": (
                "Email delivery is active. The invitation email is sent when the invite is created or resent."
                if email_delivery_active()
                else "Invite created inside PetroBrain. Email delivery is not enabled yet."
            ),
        }
    if raw_token:
        response["invite_token"] = raw_token
        response["invite_path"] = f"/invitations/{raw_token}"
    return response


def _role_label(role: str) -> str:
    return role.replace("_", " ").title()


def _deliver_invitation(
    *, tenant_id: str, email: str, role: str, raw_token: str, expires_at: Any, message: str | None
) -> dict[str, Any]:
    tenant = _tenant_or_404(tenant_id)
    return send_invitation_email(
        to_email=email,
        company_name=tenant["name"],
        role_label=_role_label(role),
        raw_token=raw_token,
        expires_at=expires_at,
        message=message,
    )


def _public_organization(tenant: dict[str, Any]) -> dict[str, Any]:
    return {
        "tenant_id": tenant["id"],
        "company_name": tenant["name"],
        "status": tenant["status"],
        **(tenant.get("attributes") or {}),
    }


def _merge_tenant_attributes(tenant_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    tenant = _tenant_or_404(tenant_id)
    return _update_tenant(
        tenant_id,
        name=tenant["name"],
        attributes={**(tenant.get("attributes") or {}), **changes},
    )


def _update_tenant(
    tenant_id: str, *, name: str, attributes: dict[str, Any]
) -> dict[str, Any]:
    return get_tenants_repository().update(tenant_id, name=name, attributes=attributes)


def _tenant_or_404(tenant_id: str) -> dict[str, Any]:
    tenant = get_tenants_repository().get(tenant_id)
    if tenant is None:
        raise HTTPException(status_code=404, detail="organization not found")
    return tenant


def _users():
    return get_users_repository()


def _onboarding():
    return get_onboarding_repository()


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def _audit(
    event_type: str,
    who: Principal,
    request: dict[str, Any],
    response: dict[str, Any] | None,
) -> None:
    audit_logger.write(AuditEvent(
        event_type=event_type,
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/onboarding",
        request=request,
        response=response,
        metadata={"account_setup": True},
    ))


def _audit_for_record(
    event_type: str,
    user: dict[str, Any],
    request: dict[str, Any],
    response: dict[str, Any] | None,
) -> None:
    audit_logger.write(AuditEvent(
        event_type=event_type,
        tenant_id=user["tenant_id"],
        user_id=user["id"],
        role=user["role"],
        route="/invitations/accept",
        request=request,
        response=response,
        metadata={"account_setup": True},
    ))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
