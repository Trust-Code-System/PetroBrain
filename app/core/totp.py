"""
Two-factor (TOTP) primitives: authenticator secrets, code verification,
one-time recovery codes, and the short-lived "MFA challenge" token that
bridges the password step and the code step of sign-in.

Design notes:
  * The challenge token is signed with a namespaced derivative of the JWT
    secret (``<secret>::mfa``) so it can never be replayed as a real access
    token - ``app.api.deps.get_principal`` verifies against the bare secret and
    would reject this signature outright. It carries only enough to resume the
    flow (tenant_id, user_id) and a tight ``exp``.
  * Recovery codes are stored as bcrypt hashes, exactly like passwords; the
    plaintext is shown to the user once at enrollment and never persisted.
  * TOTP verification uses a +/-1 step window to tolerate clock skew.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import bcrypt
import jwt
import pyotp


MFA_TOKEN_PURPOSE = "mfa_challenge"
RECOVERY_CODE_COUNT = 10


def generate_secret() -> str:
    """A fresh base32 TOTP secret for a new enrollment."""
    return pyotp.random_base32()


def provisioning_uri(secret: str, *, account_email: str, issuer: str) -> str:
    """The ``otpauth://`` URI an authenticator app imports (we render it as a
    QR on the client). ``issuer`` is the label the app shows, e.g. PetroBrain."""
    return pyotp.TOTP(secret).provisioning_uri(name=account_email, issuer_name=issuer)


def verify_totp(secret: str | None, code: str) -> bool:
    """True if ``code`` is a currently-valid 6-digit TOTP for ``secret``.

    Tolerates one step of clock skew on either side. Non-digit / wrong-length
    input is rejected before hitting pyotp so a junk code can't raise.
    """
    if not secret:
        return False
    cleaned = (code or "").strip().replace(" ", "")
    if len(cleaned) != 6 or not cleaned.isdigit():
        return False
    try:
        return pyotp.TOTP(secret).verify(cleaned, valid_window=1)
    except Exception:  # noqa: BLE001 - any pyotp failure is a non-match, not a 500
        return False


def generate_recovery_codes(count: int = RECOVERY_CODE_COUNT) -> list[str]:
    """Human-friendly one-time backup codes, e.g. ``a1b2c3d4-e5f6g7h8``.

    Returned as plaintext for the one-time display; callers must hash them with
    :func:`hash_recovery_codes` before storing.
    """
    return [f"{secrets.token_hex(4)}-{secrets.token_hex(4)}" for _ in range(count)]


def hash_recovery_codes(codes: list[str]) -> list[str]:
    return [
        bcrypt.hashpw(code.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
        for code in codes
    ]


def consume_recovery_code(code: str, hashed: list[str]) -> list[str] | None:
    """If ``code`` matches one of the stored bcrypt hashes, return the remaining
    hashes (that code burned); otherwise return None. Single-use by construction.
    """
    cleaned = (code or "").strip().lower()
    if not cleaned:
        return None
    encoded = cleaned.encode("utf-8")
    for index, stored in enumerate(hashed):
        try:
            if bcrypt.checkpw(encoded, stored.encode("utf-8")):
                return [h for i, h in enumerate(hashed) if i != index]
        except ValueError:
            continue
    return None


def _mfa_secret(jwt_secret: str) -> str:
    return f"{jwt_secret}::mfa"


def mint_challenge_token(
    *,
    user_id: str,
    tenant_id: str,
    jwt_secret: str,
    ttl: timedelta,
) -> str:
    """Short-lived token proving the password step passed, pending the code."""
    if not jwt_secret:
        raise ValueError("jwt secret is required to mint a challenge token")
    now = datetime.now(timezone.utc)
    claims = {
        "sub": user_id,
        "user_id": user_id,
        "tenant_id": tenant_id,
        "purpose": MFA_TOKEN_PURPOSE,
        "iat": now,
        "exp": now + ttl,
        "jti": str(uuid4()),
    }
    return jwt.encode(claims, _mfa_secret(jwt_secret), algorithm="HS256")


def verify_challenge_token(token: str, *, jwt_secret: str) -> dict | None:
    """Return the claims for a valid, unexpired challenge token, else None."""
    if not token:
        return None
    try:
        claims = jwt.decode(token, _mfa_secret(jwt_secret), algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if claims.get("purpose") != MFA_TOKEN_PURPOSE:
        return None
    if not claims.get("user_id") or not claims.get("tenant_id"):
        return None
    return claims
