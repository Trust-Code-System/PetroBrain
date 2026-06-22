"""
Account area API (Group 1): profile, preferences, organization config, team
roster, and the copilot's tenant memory.

Endpoints (all consumed by the frontend's lib/account/client.ts via the /api/pb
proxy, so the paths/shapes match it exactly):

  GET    /profile            - current user's profile card
  PATCH  /profile            - update display name
  POST   /profile/avatar     - upload avatar image (multipart "file")
  GET    /profile/avatar     - stream the current user's avatar bytes
  GET    /org                - tenant organization + reporting config
  PATCH  /org                - update org config (admin)
  GET    /settings           - current user's preferences
  PATCH  /settings           - update preferences
  GET    /team               - tenant roster (admin / auditor)
  GET    /memory             - tenant copilot memories
  PATCH  /memory/{id}        - edit a memory's text (admin)
  DELETE /memory/{id}        - archive a memory (admin)

Every route authenticates via the shared Neon-JWT dependency (``get_principal``)
and is tenant-scoped: reads/writes only ever touch ``who.tenant_id``. Role gates
mirror the frontend's lib/auth/permissions.ts (org.manage / members.view).

Stored fields are snake_case (see account_repository); responses are mapped to
the camelCase the frontend types expect.
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.api.deps import (
    Principal,
    canonical_role,
    get_principal,
    is_platform_admin,
    is_tenant_admin,
    require_role,
)
from app.db.account_repository import get_account_repository
from app.db.assets_repository import get_assets_repository
from app.db.tenant_memory_repository import get_tenant_memory_repository
from app.db.users_repository import get_users_repository
from app.storage.object_store import get_object_store


router = APIRouter(tags=["account"])

# Avatars are small profile images; cap defence-in-depth (the edge proxy also
# validates type + size in lib/uploads). 2 MiB is generous for an avatar.
MAX_AVATAR_BYTES = 2 * 1024 * 1024
_ALLOWED_AVATAR_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


# --- request schemas (camelCase to match the frontend payloads) -------------

class ProfileUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class NotificationPrefsModel(BaseModel):
    product: bool
    reports: bool
    alerts: bool


class OpportunityAlertPrefsModel(BaseModel):
    newRoundCountries: list[str] = Field(default_factory=list)
    deadlineReminders: bool = False
    addendumOnWatched: bool = False


class UserSettingsUpdate(BaseModel):
    units: Literal["oilfield", "metric"] | None = None
    language: Literal["en", "pcm", "yo", "ha"] | None = None
    notifications: NotificationPrefsModel | None = None
    opportunityAlerts: OpportunityAlertPrefsModel | None = None


class OrgSettingsUpdate(BaseModel):
    company: str | None = Field(default=None, max_length=200)
    country: str | None = Field(default=None, max_length=120)
    segment: Literal["upstream", "midstream", "downstream", "integrated"] | None = None
    reportingBoundary: (
        Literal["operational_control", "financial_control", "equity_share"] | None
    ) = None
    units: Literal["oilfield", "metric"] | None = None
    gwpSet: Literal["ar5", "ar6"] | None = None
    frameworks: list[str] | None = None


class MemoryContentUpdate(BaseModel):
    content: str = Field(min_length=1)


# --- response mappers -------------------------------------------------------

def _profile_response(who: Principal) -> dict[str, Any]:
    repo = get_account_repository()
    us = repo.get_user_settings(tenant_id=who.tenant_id, user_id=who.user_id)
    org = repo.get_org_settings(tenant_id=who.tenant_id)
    email, role = _user_identity(who)
    out: dict[str, Any] = {
        "id": who.user_id,
        "name": us["display_name"],
        "email": email,
        "role": role,
    }
    if org["company"]:
        out["org"] = org["company"]
    if us.get("avatar_url"):
        out["avatarUrl"] = us["avatar_url"]
    return out


def _user_identity(who: Principal) -> tuple[str, str]:
    """Resolve the email/role from the users table when the user is provisioned;
    fall back to the token's claims (email unknown -> "") otherwise. The token's
    role is authoritative for access; the stored row is only for display."""
    try:
        row = get_users_repository().get(tenant_id=who.tenant_id, user_id=who.user_id)
    except Exception:  # noqa: BLE001 - never let a directory blip break the profile card
        row = None
    email = (row or {}).get("email", "") or ""
    role = (row or {}).get("role") or who.role
    return email, role


def _settings_response(us: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "units": us["units"],
        "language": us["language"],
        "notifications": us["notifications"],
    }
    if us.get("opportunity_alerts"):
        out["opportunityAlerts"] = us["opportunity_alerts"]
    return out


def _org_response(org: dict[str, Any], asset_count: int) -> dict[str, Any]:
    return {
        "company": org["company"],
        "country": org["country"],
        "segment": org["segment"],
        "reportingBoundary": org["reporting_boundary"],
        "units": org["units"],
        "gwpSet": org["gwp_set"],
        "frameworks": list(org["frameworks"] or []),
        "assetCount": asset_count,
    }


def _memory_response(row: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"id": row["id"], "content": row.get("body", "")}
    if row.get("kind"):
        out["kind"] = row["kind"]
    if row.get("created_utc"):
        out["createdAt"] = row["created_utc"]
    return out


# --- profile ----------------------------------------------------------------

@router.get("/profile")
async def get_profile(who: Principal = Depends(get_principal)):
    return _profile_response(who)


@router.patch("/profile")
async def update_profile(req: ProfileUpdate, who: Principal = Depends(get_principal)):
    get_account_repository().upsert_user_settings(
        tenant_id=who.tenant_id, user_id=who.user_id,
        changes={"display_name": req.name.strip()},
    )
    return _profile_response(who)


@router.post("/profile/avatar")
async def upload_avatar(
    file: UploadFile = File(...), who: Principal = Depends(get_principal),
):
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    if content_type not in _ALLOWED_AVATAR_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"avatar must be one of {sorted(_ALLOWED_AVATAR_TYPES)}",
        )
    data = await file.read()
    if not data:
        raise HTTPException(status_code=422, detail="empty file")
    if len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"avatar exceeds {MAX_AVATAR_BYTES} bytes",
        )
    get_object_store().put(_avatar_key(who), data, content_type=content_type)
    # Cache-bust so a re-uploaded avatar replaces the old one in the browser; the
    # backend GET ignores the query string. The URL is relative - the frontend
    # proxies it through /api/pb (which forwards the Bearer token).
    from time import time

    repo = get_account_repository()
    repo.upsert_user_settings(
        tenant_id=who.tenant_id, user_id=who.user_id,
        changes={"avatar_url": f"profile/avatar?v={int(time())}"},
    )
    return _profile_response(who)


@router.get("/profile/avatar")
async def get_avatar(who: Principal = Depends(get_principal)):
    try:
        data = get_object_store().get(_avatar_key(who))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no avatar set") from exc
    return Response(
        content=data,
        media_type=_sniff_image_type(data),
        headers={"Cache-Control": "private, max-age=300"},
    )


# --- organization -----------------------------------------------------------

@router.get("/org")
async def get_org(who: Principal = Depends(get_principal)):
    org = get_account_repository().get_org_settings(tenant_id=who.tenant_id)
    return _org_response(org, _asset_count(who.tenant_id))


@router.patch("/org")
async def update_org(
    req: OrgSettingsUpdate,
    who: Principal = Depends(require_role("admin", "tenant_owner", "platform_admin")),
):
    changes = _to_storage(
        req.model_dump(exclude_unset=True),
        {"reportingBoundary": "reporting_boundary", "gwpSet": "gwp_set"},
    )
    org = get_account_repository().upsert_org_settings(
        tenant_id=who.tenant_id, changes=changes,
    )
    return _org_response(org, _asset_count(who.tenant_id))


# --- preferences ------------------------------------------------------------

@router.get("/settings")
async def get_settings_route(who: Principal = Depends(get_principal)):
    us = get_account_repository().get_user_settings(
        tenant_id=who.tenant_id, user_id=who.user_id,
    )
    return _settings_response(us)


@router.patch("/settings")
async def update_settings(req: UserSettingsUpdate, who: Principal = Depends(get_principal)):
    changes = _to_storage(
        req.model_dump(exclude_unset=True),
        {"opportunityAlerts": "opportunity_alerts"},
    )
    us = get_account_repository().upsert_user_settings(
        tenant_id=who.tenant_id, user_id=who.user_id, changes=changes,
    )
    return _settings_response(us)


# --- team -------------------------------------------------------------------

@router.get("/team")
async def list_team(who: Principal = Depends(get_principal)):
    # organization.members.view: admin / platform_admin / auditor (permissions.ts).
    if not (is_tenant_admin(who) or is_platform_admin(who)
            or canonical_role(who.role) == "auditor"):
        raise HTTPException(status_code=403, detail="not allowed to view the team roster")
    account = get_account_repository()
    users = get_users_repository().list_records(tenant_id=who.tenant_id)
    items: list[dict[str, Any]] = []
    for row in users:
        prefs = account.get_user_settings(tenant_id=who.tenant_id, user_id=row["id"])
        items.append({
            "id": row["id"],
            "name": prefs["display_name"] or row.get("email", ""),
            "email": row.get("email", ""),
            "role": row.get("role", ""),
            "status": "active" if row.get("status") == "active" else "invited",
        })
    return {"items": items}


# --- copilot memory ---------------------------------------------------------

@router.get("/memory")
async def list_memory(who: Principal = Depends(get_principal)):
    # The account area surfaces the signed-in user's *own* copilot memories
    # (the tenant-wide admin view lives under /admin/memory). Filter by the
    # creator so a teammate's memories never leak onto this page.
    rows = get_tenant_memory_repository().list_records(
        tenant_id=who.tenant_id, status="active", limit=200,
    )
    mine = [r for r in rows if r.get("created_by") == who.user_id]
    return {"items": [_memory_response(r) for r in mine]}


@router.patch("/memory/{memory_id}")
async def update_memory(
    memory_id: str, req: MemoryContentUpdate, who: Principal = Depends(get_principal),
):
    _own_memory_or_404(who, memory_id)
    try:
        # check_memory_body runs inside the repository update before persisting.
        record = get_tenant_memory_repository().update(
            tenant_id=who.tenant_id, memory_id=memory_id, body=req.content,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="memory not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _memory_response(record.as_dict())


@router.delete("/memory/{memory_id}", status_code=204)
async def delete_memory(memory_id: str, who: Principal = Depends(get_principal)):
    _own_memory_or_404(who, memory_id)
    try:
        # Soft delete: archive keeps the audit trail and removes it from prompts.
        get_tenant_memory_repository().update(
            tenant_id=who.tenant_id, memory_id=memory_id, status="archived",
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="memory not found") from exc
    return Response(status_code=204)


# --- helpers ----------------------------------------------------------------

def _own_memory_or_404(who: Principal, memory_id: str) -> None:
    """A user may only edit/archive memories they created. Respond 404 (not 403)
    for someone else's memory so its existence never leaks across the tenant."""
    row = get_tenant_memory_repository().get(
        tenant_id=who.tenant_id, memory_id=memory_id,
    )
    if row is None or row.get("created_by") != who.user_id:
        raise HTTPException(status_code=404, detail="memory not found")


def _to_storage(payload: dict[str, Any], rename: dict[str, str]) -> dict[str, Any]:
    """Map a camelCase patch payload to the repository's snake_case keys."""
    return {rename.get(k, k): v for k, v in payload.items()}


def _asset_count(tenant_id: str) -> int:
    try:
        return len(get_assets_repository().list_records(tenant_id=tenant_id))
    except Exception:  # noqa: BLE001 - assetCount is advisory; never block the org card
        return 0


def _avatar_key(who: Principal) -> str:
    # Tenant + user scoped key, derived from the verified principal (never from
    # client input) so a user can only ever read/write their own avatar.
    return f"tenants/{who.tenant_id}/avatars/{who.user_id}"


def _sniff_image_type(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"
