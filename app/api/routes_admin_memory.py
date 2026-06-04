"""
Admin API for tenant-scoped prompt memory (slice 2 of the learning loop).

GET    /admin/memory                          - list active (or archived) memories
POST   /admin/memory                          - create a new memory
PATCH  /admin/memory/{memory_id}              - edit body / kind / archive
POST   /admin/memory/from-feedback/{feedback_id}
                                              - promote a 👎 reason into a memory

Role-gated to admin / platform_admin. Tenant-scoped via RLS + in-app filter
(same pattern as routes_admin_audit / routes_admin_feedback). Cross-tenant
access requires platform_admin.

Safety:
  * Every create / update / promote runs the memory body through
    ``check_memory_body`` (see app.core.memory_guard). The orchestrator's
    prompt assembler ALSO checks at inject time, so a row that bypasses this
    route (direct DB write) still cannot reach the model.
  * Memory is advisory context; it CANNOT override the base safety rules,
    the calc engine, or the guardrail layer. See the <tenant_memory> block
    in app/core/prompts.py.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.api.deps import Principal, is_platform_admin, require_role
from app.core.audit import AuditEvent, get_audit_logger
from app.core.glossary_extractor import extract_candidates
from app.core.memory_guard import check_memory_body
from app.db.feedback_repository import get_feedback_repository
from app.db.tenant_memory_repository import (
    VALID_KINDS,
    VALID_STATUSES,
    get_tenant_memory_repository,
)
from app.models.schemas import (
    MemoryCreate,
    MemoryUpdate,
    PromoteFeedbackToMemory,
)


router = APIRouter(prefix="/admin/memory", tags=["admin", "memory"])
_admin_or_platform = require_role("admin", "platform_admin")
audit_logger = get_audit_logger()

MAX_LIMIT = 200
DEFAULT_LIMIT = 100


@router.get("/glossary-candidates")
async def glossary_candidates(
    tenant_id: str | None = Query(default=None),
    min_count: int = Query(default=2, ge=2, le=20),
    limit: int = Query(default=50, ge=1, le=200),
    who: Principal = Depends(_admin_or_platform),
):
    """Suggested glossary entries based on terms recurring across this
    tenant's existing memories. The admin reviews each suggestion and can
    approve it in one click - the route doesn't auto-create memories.

    Already-promoted terminology is filtered out: if a tenant already has an
    active 'terminology' memory whose body matches the candidate term, the
    suggestion is dropped so the list doesn't loop on itself.
    """
    effective_tenant = _resolve_target_tenant(who, tenant_id)
    repo = get_tenant_memory_repository()
    # All active memories feed extraction (terminology + preference + context).
    active = repo.list_records(
        tenant_id=effective_tenant, status="active", limit=10_000,
    )
    # Existing terminology bodies excluded so we don't re-suggest what's there.
    excluded = [
        r.get("body") for r in active
        if r.get("kind") == "terminology" and r.get("body")
    ]
    candidates = extract_candidates(
        active, min_count=min_count, exclude_terms=excluded,
    )
    payload = [
        {"term": c.term, "count": c.count, "memory_ids": c.memory_ids}
        for c in candidates[:limit]
    ]
    return {
        "tenant_id": effective_tenant,
        "candidates": payload,
        "min_count": min_count,
    }


@router.get("/trend")
async def memory_trend(
    weeks: int = Query(default=12, ge=1, le=52),
    tenant_id: str | None = Query(default=None),
    who: Principal = Depends(_admin_or_platform),
):
    """Weekly count of memories added (manual vs. promoted from feedback)
    for the last ``weeks`` ISO weeks. Gap-free so the chart x-axis is
    regular. Use alongside /admin/feedback/trend to see whether feedback
    volume is translating into actionable memory growth."""
    effective_tenant = _resolve_target_tenant(who, tenant_id)
    series = get_tenant_memory_repository().count_promotions_by_week(
        tenant_id=effective_tenant, weeks=weeks,
    )
    return {
        "tenant_id": effective_tenant,
        "weeks": weeks,
        "series": series,
    }


@router.get("")
async def list_memory(
    tenant_id: str | None = Query(default=None),
    status: str | None = Query(default="active"),
    kind: str | None = Query(default=None),
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    who: Principal = Depends(_admin_or_platform),
):
    if status is not None and status not in VALID_STATUSES:
        raise HTTPException(
            status_code=422,
            detail=f"status must be one of {sorted(VALID_STATUSES)}",
        )
    if kind is not None and kind not in VALID_KINDS:
        raise HTTPException(
            status_code=422,
            detail=f"kind must be one of {sorted(VALID_KINDS)}",
        )
    effective_tenant = _resolve_target_tenant(who, tenant_id)
    rows = get_tenant_memory_repository().list_records(
        tenant_id=effective_tenant, status=status, kind=kind,
        limit=limit, offset=offset,
    )
    return {
        "memories": rows,
        "tenant_id": effective_tenant,
        "limit": limit,
        "offset": offset,
    }


@router.post("", status_code=201)
async def create_memory(
    req: MemoryCreate,
    tenant_id: str | None = Query(default=None),
    who: Principal = Depends(_admin_or_platform),
):
    _ensure_kind(req.kind)
    _ensure_safe_body(req.body)
    effective_tenant = _resolve_target_tenant(who, tenant_id)
    repo = get_tenant_memory_repository()
    try:
        record = repo.create(
            tenant_id=effective_tenant, kind=req.kind, body=req.body,
            created_by=who.user_id, source="manual",
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _audit("memory_create", who, record.id, effective_tenant, {"kind": req.kind})
    return record.as_dict()


@router.patch("/{memory_id}")
async def update_memory(
    memory_id: str,
    req: MemoryUpdate,
    tenant_id: str | None = Query(default=None),
    who: Principal = Depends(_admin_or_platform),
):
    if req.body is not None:
        _ensure_safe_body(req.body)
    if req.kind is not None:
        _ensure_kind(req.kind)
    if req.status is not None and req.status not in VALID_STATUSES:
        raise HTTPException(
            status_code=422,
            detail=f"status must be one of {sorted(VALID_STATUSES)}",
        )
    effective_tenant = _resolve_target_tenant(who, tenant_id)
    try:
        record = get_tenant_memory_repository().update(
            tenant_id=effective_tenant, memory_id=memory_id,
            body=req.body, kind=req.kind, status=req.status,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _audit(
        "memory_update", who, memory_id, effective_tenant,
        {k: v for k, v in
         {"body_changed": req.body is not None,
          "kind": req.kind, "status": req.status}.items()
         if v is not None},
    )
    return record.as_dict()


@router.post("/from-feedback/{feedback_id}", status_code=201)
async def promote_feedback(
    feedback_id: str,
    req: PromoteFeedbackToMemory,
    tenant_id: str | None = Query(default=None),
    who: Principal = Depends(_admin_or_platform),
):
    """Promote a 👎 feedback row into a tenant memory. The admin must supply
    the final ``body`` (we don't trust the raw reason - it's user text that
    might itself contain injection attempts; the admin rewrites it into a
    safe one-sentence preference). The feedback row is referenced via
    ``source_feedback_id`` so the audit trail can be walked end-to-end."""
    _ensure_kind(req.kind)
    _ensure_safe_body(req.body)
    effective_tenant = _resolve_target_tenant(who, tenant_id)
    # Confirm the feedback row exists in the SAME tenant - prevents promoting
    # someone else's feedback even with platform admin override.
    feedback_rows = get_feedback_repository().list_records(
        tenant_id=effective_tenant, limit=10_000,
    )
    matched = next((r for r in feedback_rows if r["id"] == feedback_id), None)
    if matched is None:
        raise HTTPException(status_code=404, detail="feedback row not found in tenant")
    if matched.get("rating") != "down":
        # 👍 doesn't need correction; reject to keep the loop intentional.
        raise HTTPException(
            status_code=422,
            detail="only thumbs-down feedback may be promoted into memory",
        )
    repo = get_tenant_memory_repository()
    try:
        record = repo.create(
            tenant_id=effective_tenant, kind=req.kind, body=req.body,
            created_by=who.user_id, source="promoted_feedback",
            source_feedback_id=feedback_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _audit(
        "memory_promote_feedback", who, record.id, effective_tenant,
        {"feedback_id": feedback_id, "kind": req.kind},
    )
    return record.as_dict()


def _resolve_target_tenant(who: Principal, tenant_id: str | None) -> str:
    if tenant_id is None:
        return who.tenant_id
    if not is_platform_admin(who) and tenant_id != who.tenant_id:
        raise HTTPException(status_code=403, detail="cross-tenant access denied")
    return tenant_id


def _ensure_kind(kind: str) -> None:
    if kind not in VALID_KINDS:
        raise HTTPException(
            status_code=422,
            detail=f"kind must be one of {sorted(VALID_KINDS)}",
        )


def _ensure_safe_body(body: str) -> None:
    guard = check_memory_body(body)
    if not guard.ok:
        raise HTTPException(status_code=422, detail=guard.reason)


def _audit(
    event_type: str, who: Principal, memory_id: str, tenant_id: str,
    request: dict,
) -> None:
    audit_logger.write(AuditEvent(
        event_type=event_type,
        tenant_id=tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/admin/memory",
        request=request,
        response={"memory_id": memory_id},
        metadata={"memory_id": memory_id},
    ))
