from __future__ import annotations

import json
from time import perf_counter
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
import structlog

from app.api.deps import Principal, get_principal
from app.core.audit import AuditEvent, get_audit_logger
from app.core.audit_hash import sha256_canonical
from app.core.observability import increment_token_cost_counters, record_chat_turn
from app.core.orchestrator import Orchestrator, Turn
from app.core.module_routing import route_module
from app.core import turn_attribution
from app.core.chunk_weight_updater import update_weights_from_feedback
from app.db.audit_events_repository import get_audit_events_repository
from app.db.feedback_repository import VALID_RATINGS, get_feedback_repository
from app.models.schemas import (
    ChatRequest,
    ChatResponse,
    FeedbackRequest,
    FeedbackResponse,
)

router = APIRouter(prefix="/chat", tags=["chat"])
_orch = Orchestrator()   # in app startup, inject the retriever
audit_logger = get_audit_logger()
logger = structlog.get_logger(__name__)


@router.post("", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    stream: bool = Query(default=False),
    who: Principal = Depends(get_principal),
):
    req = req.model_copy(
        update={"module": route_module(req.message, req.module)}
    )
    turn_id = str(uuid4())
    if stream:
        return StreamingResponse(
            _stream_chat(req=req, who=who, turn_id=turn_id),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    started = perf_counter()
    turn = await _orch.handle(
        req.message, module=req.module, tenant_id=who.tenant_id,
        user_role=req.user_role or who.role, jurisdiction=req.jurisdiction,
        asset_context=req.asset_context, offline_mode=req.offline_mode,
        attachments=req.attachments, thinking_mode=req.thinking_mode,
        disable_web_search=req.disable_web_search,
    )
    latency_seconds = perf_counter() - started
    _finalize_chat_turn(
        req=req, turn=turn, who=who,
        latency_seconds=latency_seconds, turn_id=turn_id,
    )
    return ChatResponse(
        answer=turn.answer,
        tool_results=turn.tool_results,
        flags=turn.flags,
        citations=turn.citations,
        evidence_pack=turn.evidence_pack,
        turn_id=turn_id,
    )


async def _stream_chat(req: ChatRequest, who: Principal, turn_id: str):
    started = perf_counter()
    final_data = None
    async for item in _orch.stream_handle(
        req.message, module=req.module, tenant_id=who.tenant_id,
        user_role=req.user_role or who.role, jurisdiction=req.jurisdiction,
        asset_context=req.asset_context, offline_mode=req.offline_mode,
        attachments=req.attachments, thinking_mode=req.thinking_mode,
        disable_web_search=req.disable_web_search,
    ):
        event = item["event"]
        data = item["data"]
        if event == "done":
            # Inject turn_id so the frontend can wire the feedback chips.
            data = {**data, "turn_id": turn_id}
            final_data = data
        yield _sse(event, data)
    if final_data is not None:
        turn = Turn(
            answer=final_data.get("answer", ""),
            tool_results=final_data.get("tool_results", []),
            flags=final_data.get("flags", []),
            audit=final_data.get("audit", {}),
            evidence_pack=final_data.get("evidence_pack", {}),
        )
        _finalize_chat_turn(
            req=req,
            turn=turn,
            who=who,
            latency_seconds=perf_counter() - started,
            turn_id=turn_id,
        )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, sort_keys=True)}\n\n"


def _finalize_chat_turn(*, req: ChatRequest, turn: Turn, who: Principal,
                        latency_seconds: float, turn_id: str) -> None:
    audit_logger.write(AuditEvent(
        event_type="chat_turn",
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/chat",
        request={
            "request_hash": sha256_canonical(req.model_dump()),
            "module": req.module,
            "attachment_count": len(req.attachments or []),
            "disable_web_search": req.disable_web_search,
        },
        response={
            "response_hash": sha256_canonical({
                "answer": turn.answer,
                "tool_results": turn.tool_results,
                "flags": turn.flags,
            }),
        },
        flags=turn.flags,
        tool_results=[
            {
                "tool": tr.get("tool"),
                "result_hash": sha256_canonical(tr.get("result", {})),
            }
            for tr in (turn.tool_results or [])
        ],
        # turn_id is the joining key for any feedback the user later sends.
        metadata={**(turn.audit or {}), "turn_id": turn_id},
    ))
    # Slice 3: remember which chunks fed this turn so a later 👍/👎 can move
    # weights against them. Safe to call with [] - the helper short-circuits.
    chunk_ids = (turn.audit or {}).get("retrieved_chunk_ids") or []
    if isinstance(chunk_ids, list):
        turn_attribution.remember_turn_chunks(
            tenant_id=who.tenant_id, turn_id=turn_id,
            chunk_ids=[int(c) for c in chunk_ids if isinstance(c, (int, float))],
        )
    _record_audit_events(req=req, turn=turn, who=who)
    usage = (turn.audit or {}).get("usage") or {}
    model = str((turn.audit or {}).get("model") or "unknown")
    record_chat_turn(
        tenant_id=who.tenant_id,
        module=req.module,
        model=model,
        latency_seconds=latency_seconds,
        usage=usage if isinstance(usage, dict) else {},
        tool_results=turn.tool_results,
        flags=turn.flags,
    )
    increment_token_cost_counters(
        tenant_id=who.tenant_id,
        module=req.module,
        usage=usage if isinstance(usage, dict) else {},
    )
    logger.info(
        "chat_turn",
        tenant_id=who.tenant_id,
        module=req.module,
        model=model,
        latency_ms=round(latency_seconds * 1000, 2),
        input_tokens=usage.get("input", 0) if isinstance(usage, dict) else 0,
        output_tokens=usage.get("output", 0) if isinstance(usage, dict) else 0,
        n_tool_calls=len(turn.tool_results),
        guardrail_flags=turn.flags,
    )


def _record_audit_events(*, req: ChatRequest, turn, who: Principal) -> None:
    """
    Write production-shape audit_events rows for the turn + each tool call.

    Only HASHES of the request and response payloads reach this store -
    raw user text and raw model output stay out, per A6 / engineering spec.
    """
    repo = _events_repository()
    chat_request_hash = sha256_canonical({
        "message": req.message,
        "module": req.module,
        "user_role": req.user_role,
        "jurisdiction": req.jurisdiction,
        "asset_context": req.asset_context,
        "offline_mode": req.offline_mode,
    })
    chat_response_hash = sha256_canonical({
        "answer": turn.answer,
        "tool_results": turn.tool_results,
        "flags": turn.flags,
    })
    usage = (turn.audit or {}).get("usage") or {}
    repo.append(
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        action="chat",
        module=req.module,
        request_hash=chat_request_hash,
        response_hash=chat_response_hash,
        retrieved_clauses=(turn.audit or {}).get("retrieved_clauses") or [],
        flags=turn.flags or [],
        usage=usage if isinstance(usage, dict) else {},
    )
    for tr in turn.tool_results or []:
        tool_name = tr.get("tool") or "unknown"
        repo.append(
            tenant_id=who.tenant_id,
            user_id=who.user_id,
            role=who.role,
            action=f"tool:{tool_name}",
            module=req.module,
            request_hash=sha256_canonical(tr.get("input")),
            response_hash=sha256_canonical(tr.get("result")),
            retrieved_clauses=[],
            flags=[],
            usage={},
        )


def _events_repository():
    return get_audit_events_repository()


@router.post("/feedback", response_model=FeedbackResponse)
async def submit_feedback(
    req: FeedbackRequest,
    who: Principal = Depends(get_principal),
):
    """Record per-turn 👍/👎 + optional reason. Idempotent on (tenant, user,
    turn): re-submitting overwrites the previous rating. Strictly tenant-
    scoped; the system never blends feedback across tenants."""
    rating = (req.rating or "").strip().lower()
    if rating not in VALID_RATINGS:
        raise HTTPException(
            status_code=422,
            detail=f"rating must be one of {sorted(VALID_RATINGS)}",
        )
    reason = (req.reason or "").strip() or None
    repo = get_feedback_repository()
    try:
        record = repo.upsert(
            tenant_id=who.tenant_id,
            user_id=who.user_id,
            turn_id=req.turn_id,
            rating=rating,
            reason=reason,
            module=req.module,
            metadata={},
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # Slice 3: propagate the rating to per-tenant chunk weights for any
    # chunks the orchestrator actually retrieved for this turn. The lookup
    # is server-side (turn_attribution cache) so a malicious client can't
    # target arbitrary chunk_ids. Errors here are non-fatal - the feedback
    # row is already persisted.
    chunks_updated = update_weights_from_feedback(
        tenant_id=who.tenant_id, turn_id=req.turn_id, rating=rating,
    )

    audit_logger.write(AuditEvent(
        event_type="chat_feedback",
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/chat/feedback",
        request={"turn_id": req.turn_id, "rating": rating, "has_reason": bool(reason)},
        response={"feedback_id": record.id, "chunks_updated": chunks_updated},
        metadata={"module": req.module},
    ))
    return FeedbackResponse(
        id=record.id,
        turn_id=record.turn_id,
        rating=record.rating,
        reason=record.reason,
        created_utc=record.created_utc,
    )
