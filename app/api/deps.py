"""Auth + tenant resolution dependencies (RBAC down to asset/function level)."""
from __future__ import annotations

from dataclasses import dataclass
from collections.abc import Callable

import jwt
from fastapi import Depends, Header, HTTPException
from fastapi.concurrency import run_in_threadpool

from app.config import get_settings
from app.core import neon_auth


VALID_ROLES = {"platform_admin", "admin", "engineer", "field", "hse"}


@dataclass
class Principal:
    tenant_id: str
    user_id: str
    role: str
    allowed_assets: list[str]


async def get_principal(authorization: str = Header(default="")) -> Principal:
    if not authorization:
        raise HTTPException(status_code=401, detail="missing credentials")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="invalid credentials")

    # Pick the verification path by the token's algorithm. Neon Auth (Better Auth) tokens are
    # EdDSA and verified against Neon's JWKS; our own tokens are HS256/RS256.
    try:
        alg = jwt.get_unverified_header(token).get("alg")
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="invalid credentials") from exc
    if alg == "EdDSA":
        return await _neon_principal(token)

    settings = get_settings()
    key, algorithm = _jwt_key_and_algorithm(settings)
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=[algorithm],
            audience=settings.jwt_audience,
            issuer=settings.jwt_issuer,
            options={"require": ["exp", "iss", "aud"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="invalid credentials") from exc

    try:
        principal = Principal(
            tenant_id=_claim_str(claims, "tenant_id"),
            user_id=_claim_str(claims, "user_id", fallback_key="sub"),
            role=_claim_str(claims, "role"),
            allowed_assets=_claim_list(claims, "allowed_assets"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    if principal.role not in VALID_ROLES:
        raise HTTPException(status_code=401, detail="invalid credentials")
    return principal


async def _neon_principal(token: str) -> Principal:
    """
    Verify a Neon Auth (Better Auth) EdDSA token and map it to a Principal.

    Neon tokens carry the user's identity (``sub``/``email``) but not our tenant/role, so for
    now every Neon user maps into the default tenant with the default role (configurable via
    ``PB_DEFAULT_SIGNUP_TENANT_ID`` / ``PB_DEFAULT_SIGNUP_ROLE``). Real per-user tenant/role
    resolution (a memberships table keyed by the Neon ``sub``) is a follow-up.
    """
    if not neon_auth.is_configured():
        raise HTTPException(status_code=401, detail="invalid credentials")
    try:
        # JWKS fetch + verify is blocking; keep it off the event loop.
        claims = await run_in_threadpool(neon_auth.verify_neon_token, token)
    except Exception as exc:  # JWKS fetch / signature / expiry failure
        raise HTTPException(status_code=401, detail="invalid credentials") from exc

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub.strip():
        raise HTTPException(status_code=401, detail="invalid credentials")

    settings = get_settings()
    role = settings.default_signup_role
    if role not in VALID_ROLES:
        role = "engineer"
    return Principal(
        tenant_id=settings.default_signup_tenant_id,
        user_id=sub,
        role=role,
        allowed_assets=["*"],
    )


def require_role(*roles: str) -> Callable[[Principal], Principal]:
    allowed = set(roles)
    unknown = allowed - VALID_ROLES
    if unknown:
        raise ValueError(f"unknown roles: {sorted(unknown)}")

    def checker(principal: Principal = Depends(get_principal)) -> Principal:
        if principal.role not in allowed:
            raise HTTPException(status_code=403, detail="role not allowed for principal")
        return principal

    return checker


def require_asset_access(principal: Principal, asset: str | None) -> None:
    if not asset or "*" in principal.allowed_assets:
        return
    if asset not in principal.allowed_assets:
        raise HTTPException(status_code=403, detail="asset not allowed for principal")


def require_tenant_access(principal: Principal, tenant_id: str) -> None:
    """
    Cross-tenant authorisation gate (B8).

    Platform admins can act on any tenant; everyone else is locked to
    their own. Routes that take a tenant_id path/query parameter call
    this before reading or writing.
    """
    if principal.role == "platform_admin":
        return
    if principal.tenant_id != tenant_id:
        raise HTTPException(
            status_code=403,
            detail="cross-tenant access denied",
        )


def is_platform_admin(principal: Principal) -> bool:
    return principal.role == "platform_admin"


def _jwt_key_and_algorithm(settings) -> tuple[str, str]:
    if settings.jwt_public_key:
        return settings.jwt_public_key, "RS256"
    if settings.jwt_secret:
        return settings.jwt_secret, "HS256"
    raise HTTPException(status_code=500, detail="JWT verification key is not configured")


def _claim_str(claims: dict, key: str, *, fallback_key: str | None = None) -> str:
    value = claims.get(key)
    if value is None and fallback_key:
        value = claims.get(fallback_key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"missing or invalid JWT claim: {key}")
    return value


def _claim_list(claims: dict, key: str) -> list[str]:
    value = claims.get(key, [])
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"missing or invalid JWT claim: {key}")
    return value
