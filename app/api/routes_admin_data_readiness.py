"""
Data-readiness score (B8).

Derives a per-tenant readiness signal from the data we already store:

  * documents_loaded      - count of admin-uploaded docs (A5 store)
  * documents_done        - subset with status='done' (text indexed)
  * documents_failed      - subset with status='failed'
  * assets_total          - count of registered assets (A9 store)
  * assets_by_type        - breakdown so the dashboard can show gaps
  * users_active          - count of activated users (B8 users repo)
  * users_pending         - count of invited but not yet active users
  * connector_status      - Phase-1 stub (no historian connector yet)

Every numeric is rolled into a 0-100 ``readiness_pct`` weighted by the
roadmap's priorities (documents 50, assets 30, users 10, connectors 10).

Tenant scoping:
  * platform_admin can pass ?tenant_id=X to read any tenant.
  * Anyone else gets their own tenant - the ?tenant_id parameter is
    rejected with 403 if it disagrees with the principal's tenant.
"""
from __future__ import annotations

from collections import Counter
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import (
    Principal,
    is_platform_admin,
    require_role,
)
from app.db.admin_document_repository import get_admin_document_repository
from app.db.assets_repository import get_assets_repository
from app.db.users_repository import get_users_repository


router = APIRouter(prefix="/admin/data-readiness", tags=["admin", "data_readiness"])

_admin_or_platform = require_role("admin", "platform_admin")


@router.get("")
async def get_readiness(
    tenant_id: str | None = Query(default=None),
    who: Principal = Depends(_admin_or_platform),
):
    target_tenant = _resolve_target_tenant(who, tenant_id)
    return _compute(target_tenant)


def _resolve_target_tenant(principal: Principal, requested: str | None) -> str:
    if requested is None:
        return principal.tenant_id
    if requested != principal.tenant_id and not is_platform_admin(principal):
        raise HTTPException(status_code=403, detail="cross-tenant access denied")
    return requested


def _compute(tenant_id: str) -> dict[str, Any]:
    documents = _admin_documents().list_records(tenant_id=tenant_id)
    doc_total = len(documents)
    doc_done = sum(1 for d in documents if d.get("status") == "done")
    doc_failed = sum(1 for d in documents if d.get("status") == "failed")

    assets = _assets().list_records(tenant_id=tenant_id)
    asset_total = len(assets)
    asset_by_type = Counter(a.type for a in assets)

    users_active = _users().list_records(tenant_id=tenant_id, status="active")
    users_pending = _users().list_records(tenant_id=tenant_id, status="invited")

    documents_pct = _ratio(doc_done, doc_total)
    assets_pct = _asset_completeness(asset_by_type)
    users_pct = 100.0 if users_active else 0.0
    connectors_pct = 0.0  # stub until historian connector ships (Phase 2)

    readiness_pct = round(
        documents_pct * 0.5
        + assets_pct * 0.3
        + users_pct * 0.1
        + connectors_pct * 0.1,
        2,
    )

    return {
        "tenant_id": tenant_id,
        "readiness_pct": readiness_pct,
        "documents": {
            "loaded": doc_total,
            "indexed": doc_done,
            "failed": doc_failed,
            "score_pct": round(documents_pct, 2),
        },
        "assets": {
            "total": asset_total,
            "by_type": dict(asset_by_type),
            "score_pct": round(assets_pct, 2),
        },
        "users": {
            "active": len(users_active),
            "pending_invites": len(users_pending),
            "score_pct": round(users_pct, 2),
        },
        "connectors": {
            "status": "not_wired",
            "note": "Historian / CMMS connectors land in Phase 2.",
            "score_pct": round(connectors_pct, 2),
        },
        "weights": {
            "documents": 0.5,
            "assets": 0.3,
            "users": 0.1,
            "connectors": 0.1,
        },
    }


def _asset_completeness(by_type: Counter) -> float:
    """
    Asset hierarchy is considered complete when the canonical four levels
    (field, block, train, equipment) are present. Each level contributes
    25%. Tenants using a different naming convention still get credit for
    every recognised level - better partial coverage than a hard zero.
    """
    expected = ("field", "block", "train", "equipment")
    return sum(25.0 for level in expected if by_type.get(level, 0) > 0)


def _ratio(numerator: int, denominator: int) -> float:
    if denominator <= 0:
        return 0.0
    return 100.0 * numerator / denominator


def _admin_documents():
    return get_admin_document_repository()


def _assets():
    return get_assets_repository()


def _users():
    return get_users_repository()
