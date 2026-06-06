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
from app.core.guardrails import detect_safety_event
from app.core.observability import increment_token_cost_counters, record_chat_turn
from app.core.orchestrator import Orchestrator, Turn
from app.core.progress import normalize_stream_data
from app.core.module_routing import ModuleRouteDecision, ModuleRouter
from app.core import turn_attribution
from app.core.chunk_weight_updater import update_weights_from_feedback
from app.db.audit_events_repository import get_audit_events_repository
from app.db.feedback_repository import VALID_RATINGS, get_feedback_repository
from app.db.notifications_repository import get_notifications_repository
from app.core.task_service import is_audit_request, is_task_request, parse_task_request
from app.api.routes_tasks import create_task_for_chat
from app.config import get_settings
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
module_router = ModuleRouter()


@router.post("", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    stream: bool = Query(default=False),
    who: Principal = Depends(get_principal),
):
    safety_event = detect_safety_event(req.message)
    if safety_event is not None:
        _escalate_safety_event(req=req, who=who, safety_event=safety_event)

    command_turn = None
    if safety_event is None and is_task_request(req.message):
        command_turn = _task_command_turn(req, who)
    elif safety_event is None and is_audit_request(req.message):
        command_turn = _audit_command_turn(req, who)

    routing = module_router.route(
        user_message=req.message,
        selected_module=req.requested_module or req.module,
        auto_route_enabled=req.auto_route_enabled,
        module_pinned=req.module_pinned,
        attachments=req.attachments,
        asset_context=req.asset_context,
        conversation_context=req.conversation_context,
    )
    req = req.model_copy(
        update={"module": routing.selected_module_for_this_turn}
    )
    turn_id = str(uuid4())
    if command_turn is not None:
        if stream:
            return StreamingResponse(
                _stream_prebuilt_turn(
                    req=req, who=who, turn_id=turn_id,
                    routing=routing, turn=command_turn,
                ),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        _finalize_chat_turn(
            req=req, turn=command_turn, who=who, latency_seconds=0, turn_id=turn_id,
        )
        return ChatResponse(
            answer=command_turn.answer,
            tool_results=command_turn.tool_results,
            flags=command_turn.flags,
            citations=command_turn.citations,
            evidence_pack=command_turn.evidence_pack,
            turn_id=turn_id,
            requested_module=routing.requested_module,
            resolved_module=routing.selected_module_for_this_turn,
            routing_confidence=routing.routing_confidence,
            routing_reason=routing.reason,
            user_visible_notice=routing.user_visible_notice,
            routing_safety_flags=routing.safety_flags,
        )
    if stream:
        return StreamingResponse(
            _stream_chat(req=req, who=who, turn_id=turn_id, routing=routing),
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
        requested_module=routing.requested_module,
        resolved_module=routing.selected_module_for_this_turn,
        routing_confidence=routing.routing_confidence,
        routing_reason=routing.reason,
        should_prompt_user=routing.should_prompt_user,
        user_visible_notice=routing.user_visible_notice,
        routing_safety_flags=routing.safety_flags,
    )


async def _stream_chat(
    req: ChatRequest,
    who: Principal,
    turn_id: str,
    routing: ModuleRouteDecision,
):
    started = perf_counter()
    final_data = None
    yield _sse("routing", normalize_stream_data("routing", {
        **routing.as_dict(),
        "step_id": "routing",
        "status": "completed",
        "message": routing.user_visible_notice or routing.reason,
    }))
    try:
        async for item in _orch.stream_handle(
            req.message, module=req.module, tenant_id=who.tenant_id,
            user_role=req.user_role or who.role, jurisdiction=req.jurisdiction,
            asset_context=req.asset_context, offline_mode=req.offline_mode,
            attachments=req.attachments, thinking_mode=req.thinking_mode,
            disable_web_search=req.disable_web_search,
        ):
            event = item["event"]
            data = normalize_stream_data(event, item["data"])
            if event == "done":
                # Inject turn_id so the frontend can wire the feedback chips.
                data = {**data, "turn_id": turn_id, **routing.as_dict()}
                final_data = data
            yield _sse(event, data)
    except Exception:  # noqa: BLE001 - stream a safe terminal event
        logger.exception(
            "chat_stream_failed",
            tenant_id=who.tenant_id,
            module=req.module,
            turn_id=turn_id,
        )
        error_data = normalize_stream_data("error", {
            "message": "PetroBrain could not complete this response. Please retry.",
            "status": "failed",
        })
        yield _sse("error", error_data)
        yield _sse("done", normalize_stream_data("done", {
            "answer": "",
            "tool_results": [],
            "flags": ["stream_error"],
            "audit": {"stopped_at": "stream_error", "module": req.module},
            "evidence_pack": {},
            "turn_id": turn_id,
            "status": "failed",
            "message": "Response stopped because of an error.",
        }))
        return
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


async def _stream_prebuilt_turn(
    *, req: ChatRequest, who: Principal, turn_id: str,
    routing: ModuleRouteDecision, turn: Turn,
):
    yield _sse("routing", normalize_stream_data("routing", {
        **routing.as_dict(),
        "step_id": "routing",
        "status": "completed",
        "message": routing.user_visible_notice or routing.reason,
    }))
    yield _sse("status", normalize_stream_data("status", {
        "step_id": "command",
        "status": "running",
        "message": "Saving the PetroBrain task..." if turn.tool_results else "Checking the audit trail...",
    }))
    for tool_result in turn.tool_results:
        yield _sse("tool_result", normalize_stream_data("tool_result", tool_result))
    yield _sse("token", normalize_stream_data("token", {"text": turn.answer}))
    yield _sse("final", normalize_stream_data("final", {
        "answer": turn.answer, "status": "completed", "message": "Response prepared.",
    }))
    done = normalize_stream_data("done", {
        "answer": turn.answer,
        "tool_results": turn.tool_results,
        "flags": turn.flags,
        "audit": turn.audit,
        "evidence_pack": turn.evidence_pack,
        "turn_id": turn_id,
        **routing.as_dict(),
    })
    yield _sse("done", done)
    _finalize_chat_turn(
        req=req, turn=turn, who=who, latency_seconds=0, turn_id=turn_id,
    )


def _task_command_turn(req: ChatRequest, who: Principal) -> Turn:
    parsed = parse_task_request(
        req.message, timezone_name=get_settings().task_default_timezone
    )
    if not parsed.create:
        missing = ", ".join(parsed.missing)
        return Turn(
            answer=f"I can create that PetroBrain task. Please provide the missing {missing}.",
            audit={"command": "task_create", "status": "needs_input"},
        )
    task = create_task_for_chat(parsed.data, who)
    recurrence = task["recurrence_type"].replace("_", " ")
    team = task.get("assigned_to_team") or "you"
    answer = (
        f"Done. I created a {recurrence} reminder for {team} to "
        f"{task['title'].rstrip('.')}. The task is saved in PetroBrain. "
        "External email/calendar notification is not enabled yet."
    )
    return Turn(
        answer=answer,
        tool_results=[{"tool": "create_task", "input": {"request": req.message}, "result": task}],
        audit={"command": "task_create", "task_id": task["task_id"]},
    )


def _audit_command_turn(req: ChatRequest, who: Principal) -> Turn:
    if who.role not in {"admin", "platform_admin"}:
        return Turn(
            answer=(
                "Audit trails are restricted to tenant administrators and platform "
                "administrators. Your request was not authorized."
            ),
            flags=["rbac_denied"],
            audit={"command": "audit_query", "status": "refused"},
        )
    rows = _events_repository().query(
        tenant_id=who.tenant_id,
        module="research" if "research" in req.message.lower() else None,
        limit=10,
    )
    if not rows:
        return Turn(
            answer="No matching audit trail was found for this tenant.",
            audit={"command": "audit_query", "status": "not_found"},
        )
    latest = rows[0]
    usage = latest.get("usage") or {}
    answer = (
        "Here is the latest matching audit event:\n\n"
        f"- Audit ID: {latest['id']}\n"
        f"- User: {latest['user_id']}\n"
        f"- Tenant: {latest['tenant_id']}\n"
        f"- Role: {latest['role']}\n"
        f"- Timestamp: {latest['ts']}\n"
        f"- Module: {latest['module']}\n"
        f"- Action: {latest['action']}\n"
        f"- Safety flags: {', '.join(latest.get('flags') or []) or 'None'}\n"
        f"- Sources/tool metadata: {json.dumps(usage.get('metadata') or {}, sort_keys=True)}"
    )
    return Turn(
        answer=answer,
        tool_results=[{"tool": "query_audit", "input": {"limit": 10}, "result": {"events": rows}}],
        audit={"command": "audit_query", "audit_id": latest["id"]},
    )


def _escalate_safety_event(*, req: ChatRequest, who: Principal, safety_event) -> None:
    settings = get_settings()
    usage = {
        "risk_level": safety_event.severity,
        "status": "escalated",
        "action_summary": "Unsafe request refused and escalated",
        "triggered_rule": safety_event.rule,
        "conversation_id": req.conversation_id,
        "session_id": req.session_id,
        "recommended_admin_action": "Review the request and confirm site/compliance follow-up.",
        "prompt_excerpt": req.message[:240] if settings.audit_store_prompt_text else None,
        "prompt_storage": "excerpt" if settings.audit_store_prompt_text else "hash_only",
    }
    audit = _events_repository().append(
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        action="bypass_attempt",
        module=req.requested_module or req.module,
        request_hash=sha256_canonical({"message": req.message}),
        response_hash=sha256_canonical({"refused": True, "rule": safety_event.rule}),
        flags=["safety_bypass", safety_event.rule],
        usage=usage,
    )
    try:
        from app.db.users_repository import get_users_repository
        user = get_users_repository().get(tenant_id=who.tenant_id, user_id=who.user_id)
    except Exception:  # noqa: BLE001
        user = None
    _notifications_repository().create(
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        user_name=(user or {}).get("email"),
        user_role=who.role,
        title=f"{safety_event.severity.upper()} SAFETY BYPASS ATTEMPT",
        message="Unsafe request refused and logged for administrator review.",
        category=safety_event.category,
        severity=safety_event.severity,
        related_audit_id=str(audit.id),
        related_conversation_id=req.conversation_id,
        related_module=req.requested_module or req.module,
        triggered_rule=safety_event.rule,
        metadata={
            "action_taken": "Refused and logged",
            "prompt_hash": audit.request_hash,
            "prompt_excerpt": usage["prompt_excerpt"],
        },
    )


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
            "requested_module": req.requested_module or req.module,
            "auto_route_enabled": req.auto_route_enabled,
            "module_pinned": req.module_pinned,
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
    if "safety_bypass" in (turn.flags or []):
        return
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


def _notifications_repository():
    return get_notifications_repository()


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
