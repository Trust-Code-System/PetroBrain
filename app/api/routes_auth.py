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
from app.core import password_reset
from app.core import refresh_tokens
from app.core import totp
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
    # Long-lived, single-use, server-stored. The client calls POST /auth/refresh
    # with this to mint a new access token (and a new refresh token) when the
    # short-lived access token expires, instead of re-entering credentials.
    refresh_token: str
    principal: AuthPrincipal
    onboarding_required: bool = False
    # Only populated on the response that completes 2FA enrollment - the
    # one-time recovery codes, shown to the user once and never again.
    recovery_codes: list[str] | None = None


class MfaChallengeResponse(BaseModel):
    """Returned by /auth/signin when a second factor is required. No session
    token is issued yet; the client exchanges ``mfa_token`` (plus a code, or an
    enrollment) at /auth/2fa/verify for the real AuthResponse."""

    mfa_required: bool = True
    # False means the user must enrol first (call /auth/2fa/enroll), True means
    # they already have an authenticator and should just enter a code.
    enrolled: bool
    mfa_token: str


class MfaEnrollRequest(BaseModel):
    mfa_token: str = Field(min_length=1)


class MfaEnrollResponse(BaseModel):
    secret: str
    otpauth_uri: str
    issuer: str
    account: str


class MfaVerifyRequest(BaseModel):
    mfa_token: str = Field(min_length=1)
    code: str = Field(min_length=1)


class MfaStatusResponse(BaseModel):
    enabled: bool
    required: bool


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=1)


class ForgotPasswordRequest(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        return _validate_email(v)


class ResetPasswordRequest(BaseModel):
    token: str = Field(min_length=1)
    password: str = Field(min_length=1)


class MessageResponse(BaseModel):
    message: str


class LogoutRequest(BaseModel):
    # Optional: when present, the refresh token is revoked too so the session
    # cannot be continued after logout.
    refresh_token: str | None = None


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


def _totp_issuer(settings) -> str:
    return str(getattr(settings, "totp_issuer", "") or "PetroBrain")


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


def _issue_refresh(record: dict) -> str:
    settings = get_settings()
    return refresh_tokens.issue(
        user_id=record["id"],
        tenant_id=record["tenant_id"],
        ttl_seconds=settings.refresh_token_ttl_days * 24 * 60 * 60,
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


@router.post("/signup", status_code=201)
async def signup(req: SignupRequest) -> AuthResponse | MfaChallengeResponse:
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

    # When 2FA is mandatory, a brand-new account does not get a session yet -
    # it must enrol an authenticator first, same as signin. The user row exists
    # (active) so the challenge can resolve it; the frontend handles the
    # enrollment step identically for signup and signin.
    if bool(getattr(settings, "require_2fa", False)):
        from datetime import timedelta
        challenge = totp.mint_challenge_token(
            user_id=record["id"],
            tenant_id=record["tenant_id"],
            jwt_secret=settings.jwt_secret,
            ttl=timedelta(minutes=int(getattr(settings, "mfa_challenge_ttl_minutes", 10))),
        )
        audit_logger.write(AuditEvent(
            event_type="auth_signup",
            tenant_id=record["tenant_id"],
            user_id=record["id"],
            role=record["role"],
            route="/auth/signup",
            request={"email": record["email"]},
            response={"user_id": record["id"], "mfa_pending": True},
            metadata={"flow": "self_serve", "account_type": account_type},
        ))
        return MfaChallengeResponse(enrolled=False, mfa_token=challenge)

    token = _mint_for(record)
    refresh_token = _issue_refresh(record)
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
        refresh_token=refresh_token,
        principal=_to_principal_payload(record),
        onboarding_required=True,
    )


@router.post("/signin")
async def signin(req: SigninRequest) -> AuthResponse | MfaChallengeResponse:
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

    # Two-factor gate. The password is correct, but we do not issue a session
    # yet if 2FA applies. A user who has already enrolled is ALWAYS challenged
    # (even if the global flag is off - you can't un-enrol your way past it);
    # when PB_REQUIRE_2FA is on, an unenrolled user is sent to enroll first.
    enrolled = bool(record.get("totp_enabled"))
    if enrolled or bool(getattr(settings, "require_2fa", False)):
        from datetime import timedelta
        challenge = totp.mint_challenge_token(
            user_id=record["id"],
            tenant_id=record["tenant_id"],
            jwt_secret=settings.jwt_secret,
            ttl=timedelta(minutes=int(getattr(settings, "mfa_challenge_ttl_minutes", 10))),
        )
        audit_logger.write(AuditEvent(
            event_type="auth_signin_mfa_challenge",
            tenant_id=record["tenant_id"],
            user_id=record["id"],
            role=record["role"],
            route="/auth/signin",
            request={"email": record["email"]},
            response={"enrolled": enrolled},
            metadata={},
        ))
        return MfaChallengeResponse(enrolled=enrolled, mfa_token=challenge)

    try:
        users.touch_last_active(tenant_id=tenant_id, user_id=record["id"])
    except Exception:
        # Don't fail signin because last_active bookkeeping hiccupped.
        pass

    token = _mint_for(record)
    refresh_token = _issue_refresh(record)
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
        refresh_token=refresh_token,
        principal=_to_principal_payload(record),
        onboarding_required=onboarding_required,
    )


def _load_active_user_from_challenge(req_token: str) -> dict:
    """Resolve and validate the user behind an MFA challenge token, or 401."""
    settings = get_settings()
    expired = HTTPException(
        status_code=401, detail="this sign-in step expired, please sign in again"
    )
    claims = totp.verify_challenge_token(req_token, jwt_secret=settings.jwt_secret)
    if claims is None:
        raise expired
    record = get_users_repository().get(
        tenant_id=str(claims["tenant_id"]), user_id=str(claims["user_id"])
    )
    if record is None or record.get("status") != "active":
        raise expired
    return record


@router.post("/2fa/enroll", response_model=MfaEnrollResponse)
async def enroll_2fa(req: MfaEnrollRequest) -> MfaEnrollResponse:
    """Begin TOTP enrollment for the user behind a valid challenge token.

    Generates a fresh secret (stored as pending, not yet enabled) and returns
    the otpauth:// URI for the authenticator app. The user then proves a code
    at /auth/2fa/verify, which is what actually enables 2FA.
    """
    settings = get_settings()
    record = _load_active_user_from_challenge(req.mfa_token)
    if record.get("totp_enabled"):
        raise HTTPException(
            status_code=409,
            detail="two-factor is already set up; enter a code instead",
        )
    secret = totp.generate_secret()
    get_users_repository().set_totp_pending(
        tenant_id=record["tenant_id"], user_id=record["id"], secret=secret
    )
    return MfaEnrollResponse(
        secret=secret,
        otpauth_uri=totp.provisioning_uri(
            secret, account_email=record["email"], issuer=_totp_issuer(settings)
        ),
        issuer=_totp_issuer(settings),
        account=record["email"],
    )


@router.post("/2fa/verify", response_model=AuthResponse)
async def verify_2fa(req: MfaVerifyRequest) -> AuthResponse:
    """Complete sign-in (or enrollment) by proving a 6-digit code or a recovery
    code, exchanging the challenge token for a real access + refresh pair.

    Brute-force protection reuses the per-account lockout, keyed separately from
    the password step so the two can't exhaust each other's budgets.
    """
    record = _load_active_user_from_challenge(req.mfa_token)
    tenant_id = record["tenant_id"]
    user_id = record["id"]
    users = get_users_repository()

    lock_key = f"{record['email']}:2fa"
    if auth_lockout.is_locked(tenant_id, lock_key):
        raise HTTPException(
            status_code=429, detail="too many attempts, please wait and try again"
        )
    invalid = HTTPException(status_code=401, detail="invalid or expired code")

    recovery_codes: list[str] | None = None
    enrolling = not bool(record.get("totp_enabled"))
    if enrolling:
        secret = record.get("totp_secret")
        if not secret:
            # /auth/2fa/enroll has to run first to provision a secret.
            raise HTTPException(status_code=400, detail="start two-factor setup first")
        if not totp.verify_totp(secret, req.code):
            auth_lockout.record_failure(tenant_id, lock_key)
            raise invalid
        recovery_codes = totp.generate_recovery_codes()
        record = users.enable_totp(
            tenant_id=tenant_id,
            user_id=user_id,
            recovery_code_hashes=totp.hash_recovery_codes(recovery_codes),
        )
    else:
        if totp.verify_totp(record.get("totp_secret"), req.code):
            pass
        else:
            # Not a valid TOTP - try a one-time recovery code, which is consumed.
            remaining = totp.consume_recovery_code(
                req.code, list(record.get("totp_recovery_codes") or [])
            )
            if remaining is None:
                auth_lockout.record_failure(tenant_id, lock_key)
                raise invalid
            record = users.replace_recovery_codes(
                tenant_id=tenant_id, user_id=user_id, recovery_code_hashes=remaining
            )
    auth_lockout.record_success(tenant_id, lock_key)

    try:
        users.touch_last_active(tenant_id=tenant_id, user_id=user_id)
    except Exception:
        pass

    token = _mint_for(record)
    refresh_token = _issue_refresh(record)
    audit_logger.write(AuditEvent(
        event_type="auth_2fa_verified",
        tenant_id=tenant_id,
        user_id=user_id,
        role=record["role"],
        route="/auth/2fa/verify",
        request={"email": record["email"]},
        response={"enrolled_now": enrolling},
        metadata={"method": "totp" if not enrolling else "enrollment"},
    ))
    tenant = get_tenants_repository().get(tenant_id) or {}
    onboarding_required = (
        (tenant.get("attributes") or {}).get("onboarding_status") != "completed"
        and bool((tenant.get("attributes") or {}).get("created_by_signup"))
    )
    return AuthResponse(
        token=token,
        refresh_token=refresh_token,
        principal=_to_principal_payload(record),
        onboarding_required=onboarding_required,
        recovery_codes=recovery_codes,
    )


@router.get("/2fa/status", response_model=MfaStatusResponse)
async def mfa_status(who: Principal = Depends(get_principal)) -> MfaStatusResponse:
    """Whether the signed-in user has 2FA enabled, and whether it's mandatory."""
    settings = get_settings()
    record = get_users_repository().get(tenant_id=who.tenant_id, user_id=who.user_id)
    return MfaStatusResponse(
        enabled=bool(record and record.get("totp_enabled")),
        required=bool(getattr(settings, "require_2fa", False)),
    )


@router.post("/refresh", response_model=AuthResponse)
async def refresh(req: RefreshRequest) -> AuthResponse:
    """Exchange a valid refresh token for a new access token + a new refresh
    token (rotation). No password and no access token are required - the refresh
    token itself is the credential.

    Security properties:
      * The presented refresh token is consumed atomically (single use); a replay
        of a token that has already been rotated past fails with 401.
      * The user is re-read from the store on every refresh, so a deactivated
        account or a changed role/asset scope takes effect immediately and a
        deactivated user can never refresh.
      * The same opaque 401 is returned for unknown/expired/used tokens and for
        missing/inactive users so nothing is leaked to the caller.
    """
    invalid = HTTPException(status_code=401, detail="invalid refresh token")
    record_ref = refresh_tokens.consume(req.refresh_token)
    if record_ref is None:
        raise invalid

    users = get_users_repository()
    record = users.get(tenant_id=record_ref.tenant_id, user_id=record_ref.user_id)
    if record is None or record.get("status") != "active":
        # The refresh token was already consumed above, so an inactive user is now
        # fully logged out and must re-authenticate.
        raise invalid

    token = _mint_for(record)
    new_refresh = _issue_refresh(record)
    try:
        users.touch_last_active(tenant_id=record["tenant_id"], user_id=record["id"])
    except Exception:
        pass
    audit_logger.write(AuditEvent(
        event_type="auth_refresh",
        tenant_id=record["tenant_id"],
        user_id=record["id"],
        role=record["role"],
        route="/auth/refresh",
        request={"user_id": record["id"]},
        response={"user_id": record["id"]},
        metadata={},
    ))
    return AuthResponse(
        token=token,
        refresh_token=new_refresh,
        principal=_to_principal_payload(record),
        onboarding_required=False,
    )


@router.post("/forgot-password", response_model=MessageResponse)
async def forgot_password(req: ForgotPasswordRequest) -> MessageResponse:
    """Start a password reset for the given email.

    Deliberately enumeration-safe: the response is identical whether or not the
    email maps to an account, so an attacker can't probe which addresses are
    registered. When the email does belong to an active user we mint a
    short-lived single-use reset token and email a link; the work happens behind
    the same neutral 200.
    """
    settings = get_settings()
    # Same neutral message in every branch - never reveals account existence.
    neutral = MessageResponse(
        message="If that email belongs to an account, a reset link is on its way.",
    )

    users = get_users_repository()
    record = users.find_by_email_any_tenant(req.email)
    if record is None:
        return neutral

    try:
        ttl_minutes = int(getattr(settings, "password_reset_ttl_minutes", 30))
        raw_token = password_reset.issue(
            user_id=record["id"],
            tenant_id=record["tenant_id"],
            email=record["email"],
            ttl_seconds=ttl_minutes * 60,
        )
        from app.core.email import send_password_reset_email

        delivery = send_password_reset_email(
            to_email=record["email"], raw_token=raw_token, ttl_minutes=ttl_minutes
        )
        audit_logger.write(AuditEvent(
            event_type="auth_password_reset_requested",
            tenant_id=record["tenant_id"],
            user_id=record["id"],
            role=record["role"],
            route="/auth/forgot-password",
            request={"email": record["email"]},
            response={"email_sent": bool(delivery.get("email_sent"))},
            metadata={},
        ))
    except Exception:  # noqa: BLE001
        # Never surface an internal failure here - it would turn into an oracle
        # (error vs neutral 200 => email exists). The user can retry.
        pass
    return neutral


@router.post("/reset-password", response_model=AuthResponse)
async def reset_password(req: ResetPasswordRequest) -> AuthResponse:
    """Complete a password reset: consume the emailed token, set the new
    password, and sign the user in (returning a fresh access + refresh pair).

    The reset token is single-use and short-lived; an unknown/expired/used token
    yields an opaque 400 so nothing is leaked about why it failed.
    """
    _validate_password(req.password)

    invalid = HTTPException(
        status_code=400, detail="this reset link is invalid or has expired"
    )
    ref = password_reset.consume(req.token)
    if ref is None:
        raise invalid

    users = get_users_repository()
    record = users.get(tenant_id=ref.tenant_id, user_id=ref.user_id)
    if record is None or record.get("status") != "active":
        # The token was already consumed above, so a deactivated/missing account
        # simply cannot complete the reset.
        raise invalid

    try:
        record = users.set_password(
            tenant_id=ref.tenant_id,
            user_id=ref.user_id,
            password_hash=hash_password(req.password),
        )
    except KeyError as exc:
        raise invalid from exc

    # A successful reset clears any active lockout so the user isn't locked out of
    # the account they just regained control of.
    try:
        auth_lockout.record_success(record["tenant_id"], record["email"])
    except Exception:  # noqa: BLE001
        pass

    token = _mint_for(record)
    refresh_token = _issue_refresh(record)
    audit_logger.write(AuditEvent(
        event_type="auth_password_reset_completed",
        tenant_id=record["tenant_id"],
        user_id=record["id"],
        role=record["role"],
        route="/auth/reset-password",
        request={"email": record["email"]},
        response={"user_id": record["id"]},
        metadata={},
    ))
    return AuthResponse(
        token=token,
        refresh_token=refresh_token,
        principal=_to_principal_payload(record),
        onboarding_required=False,
    )


@router.post("/logout", status_code=204)
async def logout(
    authorization: str = Header(default=""),
    body: LogoutRequest | None = None,
    who: Principal = Depends(get_principal),
):
    """Revoke the current access token's ``jti`` so it stops being accepted
    immediately, without waiting for ``exp``. If a refresh token is supplied in
    the body it is revoked too, so the session cannot be continued. Idempotent:
    replays do nothing.

    Frontend must drop its locally-stored tokens after a 204 response - the
    server stops honouring them on the next request either way.
    """
    if body is not None and body.refresh_token:
        refresh_tokens.revoke(body.refresh_token)

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
