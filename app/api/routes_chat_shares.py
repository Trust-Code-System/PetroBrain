"""
Conversation share links (tenant-scoped).

POST /chat/shares          mint a snapshot share for the current user
GET  /chat/shares/{token}  fetch a share (requires same tenant as the share)
DELETE /chat/shares/{token}  revoke (only the creator)
GET  /chat/shares          list shares created by the current user

Frontend snapshots the conversation (it lives in the browser, not the DB)
and posts the snapshot here. The share carries the original tenant_id;
GET re-checks it against the caller's principal. RLS is the backstop.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import Principal, get_principal
from app.core.audit import AuditEvent, get_audit_logger
from app.db.conversation_share_repository import (
    SHARE_TTL_DAYS,
    get_conversation_share_repository,
)


router = APIRouter(prefix="/chat/shares", tags=["chat", "shares"])
audit_logger = get_audit_logger()


class MintShareRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    snapshot: dict[str, Any]


class ShareResponse(BaseModel):
    token: str
    title: str
    created_by: str
    created_utc: str
    expires_utc: str
    revoked_utc: str | None
    snapshot: dict[str, Any] | None = None


class ShareListResponse(BaseModel):
    shares: list[ShareResponse]


def _new_token() -> str:
    # 32 url-safe bytes -> ~43-char token, unguessable.
    return secrets.token_urlsafe(32)


def _is_active(record: dict[str, Any]) -> bool:
    if record.get("revoked_utc"):
        return False
    expires = record.get("expires_utc")
    if not expires:
        return False
    try:
        return datetime.fromisoformat(expires) > datetime.now(timezone.utc)
    except (ValueError, TypeError):
        return False


@router.post("", response_model=ShareResponse, status_code=201)
async def mint_share(req: MintShareRequest, who: Principal = Depends(get_principal)):
    repo = get_conversation_share_repository()
    record = repo.create(
        token=_new_token(),
        tenant_id=who.tenant_id,
        created_by=who.user_id,
        title=req.title,
        snapshot=req.snapshot,
        ttl_days=SHARE_TTL_DAYS,
    )
    data = record.as_dict() if hasattr(record, "as_dict") else record
    audit_logger.write(AuditEvent(
        event_type="chat_share_mint",
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/chat/shares",
        request={"title": req.title},
        response={"token": data["token"]},
        metadata={"expires_utc": data["expires_utc"]},
    ))
    return ShareResponse(
        token=data["token"],
        title=data["title"],
        created_by=data["created_by"],
        created_utc=data["created_utc"],
        expires_utc=data["expires_utc"],
        revoked_utc=data.get("revoked_utc"),
    )


@router.get("", response_model=ShareListResponse)
async def list_my_shares(who: Principal = Depends(get_principal)):
    repo = get_conversation_share_repository()
    rows = repo.list_for_owner(tenant_id=who.tenant_id, created_by=who.user_id)
    return ShareListResponse(
        shares=[
            ShareResponse(
                token=r["token"],
                title=r["title"],
                created_by=r["created_by"],
                created_utc=r["created_utc"],
                expires_utc=r["expires_utc"],
                revoked_utc=r.get("revoked_utc"),
            )
            for r in rows
        ]
    )


@router.get("/{token}", response_model=ShareResponse)
async def get_share(token: str, who: Principal = Depends(get_principal)):
    repo = get_conversation_share_repository()
    record = None
    # Postgres repo wants the tenant_id for RLS scoping; LocalJson ignores it.
    try:
        record = repo.get_by_token(token=token, tenant_id=who.tenant_id)  # type: ignore[call-arg]
    except TypeError:
        record = repo.get_by_token(token=token)
    if record is None:
        raise HTTPException(status_code=404, detail="share not found")
    # Tenant gate (the RLS backstop should already have filtered cross-tenant
    # rows out on Postgres, but be explicit so the LocalJson path agrees and
    # the error is the same on either backend).
    if record.get("tenant_id") != who.tenant_id:
        raise HTTPException(status_code=404, detail="share not found")
    if not _is_active(record):
        raise HTTPException(status_code=410, detail="share is expired or revoked")
    return ShareResponse(
        token=record["token"],
        title=record["title"],
        created_by=record["created_by"],
        created_utc=record["created_utc"],
        expires_utc=record["expires_utc"],
        revoked_utc=record.get("revoked_utc"),
        snapshot=record.get("snapshot"),
    )


@router.delete("/{token}", status_code=204)
async def revoke_share(token: str, who: Principal = Depends(get_principal)):
    repo = get_conversation_share_repository()
    try:
        record = repo.revoke(tenant_id=who.tenant_id, token=token, by_user_id=who.user_id)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if record is None:
        raise HTTPException(status_code=404, detail="share not found")
    audit_logger.write(AuditEvent(
        event_type="chat_share_revoke",
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route=f"/chat/shares/{token}",
        request={"token": token},
        response={"revoked": True},
        metadata={},
    ))
    return None
