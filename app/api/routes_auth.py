"""
Self-serve sign-up + sign-in (local email + password).

This is the JWT mint point for the office web app. Both flows return the same
``{token, principal}`` shape that the frontend's ``useChatStore.setToken``
already expects; the token is what every other route validates via
:func:`app.api.deps.get_principal`.

Multi-tenancy is intentionally simple for Phase-1: signup always lands the new
user in ``settings.default_signup_tenant_id`` with ``settings.default_signup_role``.
Admin-driven multi-tenant flows still go through ``/admin/tenants`` and the
invite-based ``/admin/tenants/{tenant_id}/users`` route.
"""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.api.deps import VALID_ROLES
from app.config import get_settings
from app.core.audit import AuditEvent, get_audit_logger
from app.core.auth import hash_password, mint_jwt, verify_password
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

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _validate_email(v)


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


def _ensure_default_tenant(tenant_id: str, name: str) -> None:
    """Create the demo tenant on first signup so we never 500 on a fresh DB."""
    repo = get_tenants_repository()
    if repo.get(tenant_id) is not None:
        return
    try:
        repo.create(id=tenant_id, name=name)
    except ValueError:
        # Race: another worker created it between our get and create. That's fine.
        pass


def _to_principal_payload(record: dict) -> AuthPrincipal:
    return AuthPrincipal(
        user_id=record["id"],
        tenant_id=record["tenant_id"],
        role=record["role"],
        email=record["email"],
        allowed_assets=list(record.get("allowed_assets") or []),
    )


def _mint_for(record: dict) -> str:
    settings = get_settings()
    from datetime import timedelta
    return mint_jwt(
        tenant_id=record["tenant_id"],
        user_id=record["id"],
        role=record["role"],
        allowed_assets=list(record.get("allowed_assets") or []),
        secret=settings.jwt_secret,
        issuer=settings.jwt_issuer,
        audience=settings.jwt_audience,
        ttl=timedelta(hours=settings.jwt_ttl_hours),
    )


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
    if settings.default_signup_role not in VALID_ROLES:
        raise HTTPException(status_code=500, detail="invalid default signup role")

    _validate_password(req.password)

    tenant_id = settings.default_signup_tenant_id
    _ensure_default_tenant(tenant_id, settings.default_signup_tenant_name)

    users = get_users_repository()
    # Friendlier error than the repo's generic ValueError so the frontend can
    # surface "already registered" without parsing the message.
    if users.get_by_email(tenant_id=tenant_id, email=req.email) is not None:
        raise HTTPException(status_code=409, detail="email is already registered")

    try:
        record = users.signup(
            tenant_id=tenant_id,
            email=str(req.email),
            role=settings.default_signup_role,
            password_hash=hash_password(req.password),
        ).as_dict()
    except ValueError as exc:
        # Lost the race with another signup for the same email.
        if "already exists" in str(exc):
            raise HTTPException(status_code=409, detail="email is already registered") from exc
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    token = _mint_for(record)
    audit_logger.write(AuditEvent(
        event_type="auth_signup",
        tenant_id=record["tenant_id"],
        user_id=record["id"],
        role=record["role"],
        route="/auth/signup",
        request={"email": record["email"]},
        response={"user_id": record["id"]},
        metadata={"flow": "self_serve"},
    ))
    return AuthResponse(token=token, principal=_to_principal_payload(record))


@router.post("/signin", response_model=AuthResponse)
async def signin(req: SigninRequest) -> AuthResponse:
    settings = get_settings()
    tenant_id = settings.default_signup_tenant_id
    users = get_users_repository()
    record = users.get_by_email(tenant_id=tenant_id, email=req.email)

    # Identical 401 for unknown email vs wrong password vs deactivated account
    # - don't leak which one to the network.
    invalid = HTTPException(status_code=401, detail="invalid email or password")
    if record is None:
        raise invalid
    if record.get("status") != "active":
        raise invalid
    if not verify_password(req.password, record.get("password_hash")):
        raise invalid

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
    return AuthResponse(token=token, principal=_to_principal_payload(record))


def looks_like_email(value: str) -> bool:
    return bool(_EMAIL_RE.match((value or "").strip()))
