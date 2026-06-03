"""
Neon Auth (Better Auth) JWT verification via JWKS.

The web app authenticates users with Neon Auth and forwards the user's short-lived
Neon access token (an EdDSA / Ed25519 JWT) to this API as a Bearer. This module verifies
that token's signature + expiry against Neon's published JWKS; the caller
(``app.api.deps.get_principal``) maps the verified claims to a ``Principal``.

Config: ``NEON_AUTH_BASE_URL`` (the Neon "Auth URL", e.g.
``https://ep-xxxx.neonauth.<region>.aws.neon.tech/neondb/auth``). The JWKS lives at
``<base>/.well-known/jwks.json``. Read directly from the environment (no ``PB_`` prefix) so
it matches the value the web app + Vercel already use. Unset → Neon tokens are rejected.
"""
from __future__ import annotations

import os
from functools import lru_cache

import jwt
from jwt import PyJWKClient


def _base_url() -> str:
    return os.getenv("NEON_AUTH_BASE_URL", "").strip().rstrip("/")


def is_configured() -> bool:
    return bool(_base_url())


@lru_cache(maxsize=1)
def _jwks_client() -> PyJWKClient:
    base = _base_url()
    if not base:
        raise RuntimeError("NEON_AUTH_BASE_URL is not set")
    # PyJWKClient caches the fetched keys (lifespan default) so this is a one-off network
    # hit per key id, not per request.
    return PyJWKClient(f"{base}/.well-known/jwks.json")


def verify_neon_token(token: str) -> dict:
    """
    Verify a Neon Auth EdDSA JWT and return its claims.

    Raises ``jwt.InvalidTokenError`` (incl. ``ExpiredSignatureError``) or a network/JWKS
    error if the token can't be verified. Audience isn't enforced (Neon's audience differs
    from this API's); the JWKS signature + ``exp`` are the security boundary.
    """
    signing_key = _jwks_client().get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["EdDSA"],
        options={"verify_aud": False, "require": ["exp"]},
    )
