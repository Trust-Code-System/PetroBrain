"""Neon Auth principal mapping (C4).

The old behaviour was: any EdDSA token that passed JWKS verification was
accepted, and the principal was synthesized into the default tenant with
allowed_assets=['*']. That silently broke tenant isolation for the SSO path.
The new behaviour: Neon Auth is opt-in (PB_NEON_AUTH_ENABLED), and the token
must resolve to an active row in the local users table - by `sub` -> users.id
(Neon RLS tokens carry the user id in `sub` and may omit email), falling back
to the `email` claim when present.
"""
from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.api import deps


def _run(coro):
    # Fresh loop per call: avoids "RuntimeError: There is no current event loop"
    # and stale-closed-loop errors when pytest's loop policy has been touched by
    # other tests in the same process.
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def test_disabled_by_default_rejects_neon_token(monkeypatch):
    monkeypatch.setattr(
        deps.get_settings.__wrapped__, "__call__", lambda: deps.get_settings(),
        raising=False,
    )
    settings = deps.get_settings()
    monkeypatch.setattr(settings, "neon_auth_enabled", False, raising=False)
    with pytest.raises(HTTPException) as exc:
        _run(deps._neon_principal("any-token"))
    assert exc.value.status_code == 401


def test_enabled_but_email_unknown_rejects(monkeypatch):
    settings = deps.get_settings()
    monkeypatch.setattr(settings, "neon_auth_enabled", True, raising=False)

    with patch("app.core.neon_auth.is_configured", return_value=True), \
         patch("app.core.neon_auth.verify_neon_token", return_value={"email": "ghost@example.com"}):
        class _NoMatchRepo:
            def find_by_email_any_tenant(self, email):  # noqa: ARG002
                return None
        with patch("app.db.users_repository.get_users_repository", return_value=_NoMatchRepo()):
            with pytest.raises(HTTPException) as exc:
                _run(deps._neon_principal("any-token"))
            assert exc.value.status_code == 401


def test_enabled_and_email_active_maps_to_local_principal(monkeypatch):
    settings = deps.get_settings()
    monkeypatch.setattr(settings, "neon_auth_enabled", True, raising=False)

    user_row = {
        "id": "u-from-neon",
        "tenant_id": "acme-corp",
        "role": "engineer",
        "status": "active",
        "allowed_assets": ["Asset-A"],
    }
    class _MatchRepo:
        def find_by_email_any_tenant(self, email):  # noqa: ARG002
            return user_row

    with patch("app.core.neon_auth.is_configured", return_value=True), \
         patch("app.core.neon_auth.verify_neon_token", return_value={"email": "u@acme.example"}), \
         patch("app.db.users_repository.get_users_repository", return_value=_MatchRepo()):
        principal = _run(deps._neon_principal("any-token"))
    assert principal.tenant_id == "acme-corp"
    assert principal.user_id == "u-from-neon"
    assert principal.role == "engineer"
    assert principal.allowed_assets == ["Asset-A"]


def test_enabled_and_sub_active_maps_to_local_principal(monkeypatch):
    """Primary path: Neon RLS token carries only `sub` (+ role) and no email;
    it must resolve via users.id."""
    settings = deps.get_settings()
    monkeypatch.setattr(settings, "neon_auth_enabled", True, raising=False)

    user_row = {
        "id": "neon-sub-abc123",
        "tenant_id": "acme-corp",
        "role": "engineer",
        "status": "active",
        "allowed_assets": ["Asset-A"],
    }
    class _MatchByIdRepo:
        def find_by_id_any_tenant(self, user_id):
            return user_row if user_id == "neon-sub-abc123" else None
        def find_by_email_any_tenant(self, email):  # noqa: ARG002
            raise AssertionError("must resolve by sub before falling back to email")

    with patch("app.core.neon_auth.is_configured", return_value=True), \
         patch("app.core.neon_auth.verify_neon_token",
               return_value={"sub": "neon-sub-abc123", "role": "authenticated"}), \
         patch("app.db.users_repository.get_users_repository", return_value=_MatchByIdRepo()):
        principal = _run(deps._neon_principal("any-token"))
    assert principal.tenant_id == "acme-corp"
    assert principal.user_id == "neon-sub-abc123"
    assert principal.role == "engineer"
    assert principal.allowed_assets == ["Asset-A"]


def test_enabled_but_sub_unknown_rejects(monkeypatch):
    settings = deps.get_settings()
    monkeypatch.setattr(settings, "neon_auth_enabled", True, raising=False)

    class _NoMatchRepo:
        def find_by_id_any_tenant(self, user_id):  # noqa: ARG002
            return None
        def find_by_email_any_tenant(self, email):  # noqa: ARG002
            return None

    with patch("app.core.neon_auth.is_configured", return_value=True), \
         patch("app.core.neon_auth.verify_neon_token",
               return_value={"sub": "ghost-sub", "role": "authenticated"}), \
         patch("app.db.users_repository.get_users_repository", return_value=_NoMatchRepo()):
        with pytest.raises(HTTPException) as exc:
            _run(deps._neon_principal("any-token"))
        assert exc.value.status_code == 401


def test_enabled_but_user_deactivated_rejects(monkeypatch):
    settings = deps.get_settings()
    monkeypatch.setattr(settings, "neon_auth_enabled", True, raising=False)

    class _DeactivatedRepo:
        def find_by_email_any_tenant(self, email):  # noqa: ARG002
            # find_by_email_any_tenant should already filter by status=active,
            # but belt-and-braces: if a stale row leaks through, _neon_principal
            # must still reject.
            return {"id": "u", "tenant_id": "t", "role": "engineer",
                    "status": "deactivated", "allowed_assets": []}

    with patch("app.core.neon_auth.is_configured", return_value=True), \
         patch("app.core.neon_auth.verify_neon_token", return_value={"email": "u@x"}), \
         patch("app.db.users_repository.get_users_repository", return_value=_DeactivatedRepo()):
        with pytest.raises(HTTPException) as exc:
            _run(deps._neon_principal("any-token"))
        assert exc.value.status_code == 401
