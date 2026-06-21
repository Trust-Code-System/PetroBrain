"""
Self-serve sign-up + sign-in (local email + password).

This is the JWT mint point for the office web app. Both flows return the same
``{token, principal}`` shape that the frontend's ``useChatStore.setToken``
already expects; the token is what every other route validates via
:func:`app.api.deps.get_principal`.

Multi-tenancy: every self-serve signup provisions its own isolated tenant
(workspace) and makes the new user its ``tenant_owner`` - one account per email
across the whole platform. A missing ``account_type`` defaults to an individual
workspace rather than dropping the user into a shared tenant, so self-serve
users are never co-mingled. Admin-driven multi-tenant flows still go through
``/admin/tenants`` and the invite-based ``/admin/tenants/{tenant_id}/users``
route; ``settings.default_signup_tenant_id`` survives only as signin's
lockout-bucket key for unknown emails.
"""
from __future__ import annotations

import re
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.api.deps import Principal, VALID_ROLES, get_principal
from app.config import get_settings
from app.core.audit import AuditEvent, get_audit_logger
from app.core import auth_lockout
from app.core.auth import hash_password, mint_jwt, verify_password
from app.core.token_revocation import revoke as revoke_jti
from app.db.tenants_repository import get_tenants_repository
from app.db.users_repository import get_users_repository


router = APIRouter(prefix="/auth", tags=["auth"])
audit_logger = get_audit_logger()


# Conservative email regex. We don't depend on pydantic's EmailStr because that
# pulls in email-validator; this is enough to keep obvious junk out and the real
# liveness check is whether they can sign in.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _validate_email(value: str) -> str:
    cleaned = (value or "").strip()
    if not _EMAIL_RE.match(cleaned):
        raise ValueError("not a valid email address")
    return cleaned


class SignupRequest(BaseModel):
    email: str
    password: str = Field(min_length=1)
    account_type: str | None = None
    full_name: str | None = Field(default=None, max_length=160)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _validate_email(v)

    @field_validator("account_type")
    @classmethod
    def _account_type(cls, value: str | None) -> str | None:
        if value is not None and value not in {"individual", "company"}:
            raise ValueError("account_type must be individual or company")
        return value


class SigninRequest(BaseModel):
    email: str
    password: str = Field(min_length=1)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _validate_email(v)


class AuthPrincipal(BaseModel):
    user_id: str
    tenant_id: str
    role: str
    email: str
    allowed_assets: list[str]


class AuthResponse(BaseModel):
    token: str
    principal: AuthPrincipal
    onboarding_required: bool = False


class CurrentPrincipal(BaseModel):
    """Authoritative identity resolved from the verified bearer token."""

    user_id: str
    tenant_id: str
    role: str
    allowed_assets: list[str]
    email: str | None = None


def _safe_delete_tenant(repo, tenant_id: str) -> None:
    """Best-effort teardown of a tenant we just created when the rest of signup
    fails - keeps a failed signup from leaving an orphaned empty workspace
    behind. Never raises: cleanup failure must not mask the original error."""
    try:
        repo.delete(tenant_id)
    except Exception:  # noqa: BLE001
        pass


def _to_principal_payload(record: dict) -> AuthPrincipal:
    return AuthPrincipal(
        user_id=record["id"],
        tenant_id=record["tenant_id"],
        role=record["role"],
        email=record["email"],
        allowed_assets=list(record.get("allowed_assets") or []),
    )


@router.get("/me", response_model=CurrentPrincipal)
async def current_principal(who: Principal = Depends(get_principal)) -> CurrentPrincipal:
    """Return the backend-resolved tenant, role and asset scope for the current user.

    Neon Auth sessions do not reliably expose PetroBrain's tenant role to the Next.js
    application. This endpoint keeps the verified backend principal authoritative so the
    frontend can mirror permissions without decoding or trusting client-controlled claims.
    """
    record = get_users_repository().get(tenant_id=who.tenant_id, user_id=who.user_id)
    return CurrentPrincipal(
        user_id=who.user_id,
        tenant_id=who.tenant_id,
        role=who.role,
        allowed_assets=list(who.allowed_assets),
        email=record.get("email") if record else None,
    )


def _mint_for(record: dict) -> str:
    settings = get_settings()
    from datetime import timedelta
    return mint_jwt(
        tenant_id=record["tenant_id"],
        user_id=record["id"],
        email=record.get("email"),
        role=record["role"],
        allowed_assets=list(record.get("allowed_assets") or []),
        secret=settings.jwt_secret,
        issuer=settings.jwt_issuer,
        audience=settings.jwt_audience,
        ttl=timedelta(hours=settings.jwt_ttl_hours),
    )


def _resolve_signup_role(email: str) -> str:
    """Return platform_admin when the email is on the bootstrap allowlist,
    otherwise the configured default. Used by /auth/signup so the founder
    (and any other named bootstrappers) can self-serve admin access without
    a chicken-and-egg admin-invites-admin flow."""
    settings = get_settings()
    raw = (getattr(settings, "bootstrap_platform_admin_emails", "") or "").strip()
    if not raw:
        return settings.default_signup_role
    needles = {e.strip().lower() for e in raw.split(",") if e.strip()}
    if email.strip().lower() in needles:
        return "platform_admin"
    return settings.default_signup_role


def _validate_password(plain: str) -> None:
    settings = get_settings()
    if len(plain) < settings.password_min_length:
        raise HTTPException(
            status_code=422,
            detail=f"password must be at least {settings.password_min_length} characters",
        )
    # bcrypt silently truncates past 72 UTF-8 bytes - reject up front so two
    # different long passwords can't collide to the same hash.
    if len(plain.encode("utf-8")) > 72:
        raise HTTPException(status_code=422, detail="password is too long (max 72 bytes)")


@router.post("/signup", response_model=AuthResponse, status_code=201)
async def signup(req: SignupRequest) -> AuthResponse:
    settings = get_settings()
    if not settings.enable_self_signup:
        raise HTTPException(status_code=403, detail="self-serve signup is disabled")

    _validate_password(req.password)
    users = get_users_repository()

    # One account per email across the whole platform. Checked up front so we
    # never provision a tenant for an email that already belongs somewhere -
    # otherwise the same email could spawn an unbounded number of workspaces.
    if users.find_by_email_any_tenant(req.email) is not None:
        raise HTTPException(status_code=409, detail="email is already registered")

    # Every self-serve signup gets its own isolated workspace; a missing
    # account_type is treated as an individual workspace rather than co-mingling
    # users in a shared tenant.
    account_type = req.account_type or "individual"
    # Founder bootstrap emails keep platform_admin; everyone else owns the tenant
    # we are about to create for them.
    base_role = _resolve_signup_role(req.email)
    role = base_role if base_role == "platform_admin" else "tenant_owner"
    if role not in VALID_ROLES:
        raise HTTPException(status_code=500, detail="invalid signup role")

    tenants = get_tenants_repository()
    tenant_id = f"{account_type}-{uuid4().hex[:12]}"
    tenants.create(
        id=tenant_id,
        name=(req.full_name or "").strip() or "New PetroBrain workspace",
        attributes={
            "account_type": account_type,
            "workspace_type": account_type,
            "onboarding_status": "in_progress",
            "created_by_signup": True,
        },
    )

    try:
        record = users.signup(
            tenant_id=tenant_id,
            email=str(req.email),
            role=role,
            password_hash=hash_password(req.password),
        ).as_dict()
    except ValueError as exc:
        # User creation failed after the tenant was created (e.g. a race that
        # registered the same email first). Tear the empty tenant back down so
        # a failed signup leaves nothing behind.
        _safe_delete_tenant(tenants, tenant_id)
        if "already exists" in str(exc):
            raise HTTPException(status_code=409, detail="email is already registered") from exc
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        _safe_delete_tenant(tenants, tenant_id)
        raise

    token = _mint_for(record)
    audit_logger.write(AuditEvent(
        event_type="auth_signup",
        tenant_id=record["tenant_id"],
        user_id=record["id"],
        role=record["role"],
        route="/auth/signup",
        request={"email": record["email"]},
        response={"user_id": record["id"]},
        metadata={"flow": "self_serve", "account_type": account_type},
    ))
    # A freshly provisioned workspace always needs onboarding.
    return AuthResponse(
        token=token,
        principal=_to_principal_payload(record),
        onboarding_required=True,
    )


@router.post("/signin", response_model=AuthResponse)
async def signin(req: SigninRequest) -> AuthResponse:
    settings = get_settings()
    users = get_users_repository()
    record = users.find_by_email_any_tenant(req.email)
    tenant_id = record["tenant_id"] if record else settings.default_signup_tenant_id

    # Identical 401 for unknown email vs wrong password vs deactivated account
    # - don't leak which one to the network.
    invalid = HTTPException(status_code=401, detail="invalid email or password")

    # H4: per-account lockout. Reject early if the email is currently locked,
    # but use the same 401 message and a fixed code path so an attacker can't
    # tell locked-out from wrong-password by timing or response shape.
    if auth_lockout.is_locked(tenant_id, req.email):
        raise invalid

    if record is None:
        # Record a failure even for unknown emails so an attacker can't probe
        # email existence by watching the lockout response. The bucket is keyed
        # by (tenant, email) so the cost is bounded.
        auth_lockout.record_failure(tenant_id, req.email)
        raise invalid
    if record.get("status") != "active":
        auth_lockout.record_failure(tenant_id, req.email)
        raise invalid
    if not verify_password(req.password, record.get("password_hash")):
        auth_lockout.record_failure(tenant_id, req.email)
        raise invalid
    auth_lockout.record_success(tenant_id, req.email)

    try:
        users.touch_last_active(tenant_id=tenant_id, user_id=record["id"])
    except Exception:
        # Don't fail signin because last_active bookkeeping hiccupped.
        pass

    token = _mint_for(record)
    audit_logger.write(AuditEvent(
        event_type="auth_signin",
        tenant_id=record["tenant_id"],
        user_id=record["id"],
        role=record["role"],
        route="/auth/signin",
        request={"email": record["email"]},
        response={"user_id": record["id"]},
        metadata={},
    ))
    tenant = get_tenants_repository().get(record["tenant_id"]) or {}
    onboarding_required = (
        (tenant.get("attributes") or {}).get("onboarding_status") != "completed"
        and bool((tenant.get("attributes") or {}).get("created_by_signup"))
    )
    return AuthResponse(
        token=token,
        principal=_to_principal_payload(record),
        onboarding_required=onboarding_required,
    )


@router.post("/logout", status_code=204)
async def logout(
    authorization: str = Header(default=""),
    who: Principal = Depends(get_principal),
):
    """Revoke the current access token's ``jti`` so it stops being accepted
    immediately, without waiting for ``exp``. Idempotent: replays do nothing.

    Frontend must drop its locally-stored token after a 204 response - the
    server stops honouring it on the next request either way.
    """
    import jwt as _jwt
    _, _, token = (authorization or "").partition(" ")
    if not token:
        return None
    try:
        # Already verified by get_principal; here we only need jti + exp.
        claims = _jwt.decode(token, options={"verify_signature": False})
    except Exception:  # noqa: BLE001
        return None
    jti = claims.get("jti")
    exp = claims.get("exp")
    if isinstance(jti, str) and jti and isinstance(exp, (int, float)):
        revoke_jti(jti, float(exp))
        audit_logger.write(AuditEvent(
            event_type="auth_logout",
            tenant_id=who.tenant_id,
            user_id=who.user_id,
            role=who.role,
            route="/auth/logout",
            request={"jti": jti},
            response=None,
            metadata={},
        ))
    return None


def looks_like_email(value: str) -> bool:
    return bool(_EMAIL_RE.match((value or "").strip()))
