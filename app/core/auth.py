"""
Password hashing + JWT minting helpers shared by /auth/signup and /auth/signin.

Hashing uses bcrypt at the library's default cost. JWT minting mirrors what
``app.api.deps.get_principal`` verifies on the way back in: HS256 with the
shared ``jwt_secret``, the ``iss`` and ``aud`` from settings, and the same
custom claims (``tenant_id``, ``user_id``, ``role``, ``allowed_assets``) that
the principal is rebuilt from.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import bcrypt
import jwt


# UTF-8 byte length, not character count; bcrypt truncates passwords past 72
# bytes silently, which is a footgun if we ever accept long passphrases.
BCRYPT_MAX_PASSWORD_BYTES = 72


def hash_password(plain: str) -> str:
    if not isinstance(plain, str) or not plain:
        raise ValueError("password is required")
    encoded = plain.encode("utf-8")
    if len(encoded) > BCRYPT_MAX_PASSWORD_BYTES:
        raise ValueError(
            f"password is too long (max {BCRYPT_MAX_PASSWORD_BYTES} UTF-8 bytes)"
        )
    return bcrypt.hashpw(encoded, bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, password_hash: str | None) -> bool:
    if not plain or not password_hash:
        return False
    encoded = plain.encode("utf-8")
    if len(encoded) > BCRYPT_MAX_PASSWORD_BYTES:
        return False
    try:
        return bcrypt.checkpw(encoded, password_hash.encode("utf-8"))
    except ValueError:
        # Malformed stored hash; treat as no-match rather than 500.
        return False


def mint_jwt(
    *,
    tenant_id: str,
    user_id: str,
    email: str | None = None,
    role: str,
    allowed_assets: list[str],
    secret: str,
    issuer: str,
    audience: str,
    ttl: timedelta = timedelta(hours=12),
) -> str:
    if not secret:
        raise ValueError("jwt secret is required to mint tokens")
    now = datetime.now(timezone.utc)
    claims = {
        "sub": user_id,
        "user_id": user_id,
        "email": email,
        "tenant_id": tenant_id,
        "role": role,
        "allowed_assets": list(allowed_assets),
        "iss": issuer,
        "aud": audience,
        "iat": now,
        "exp": now + ttl,
        # Per-token id for server-side revocation. /auth/logout pushes the jti
        # onto the revocation set with TTL = remaining lifetime so memory
        # doesn't grow unbounded; get_principal rejects any token whose jti is
        # in the set.
        "jti": str(uuid4()),
    }
    return jwt.encode(claims, secret, algorithm="HS256")
