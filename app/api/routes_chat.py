from __future__ import annotations

import json
from time import perf_counter

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
import structlog

from app.api.deps import Principal, get_principal
from app.core.audit import AuditEvent, get_audit_logger
from app.core.audit_hash import sha256_canonical
from app.core.observability import increment_token_cost_counters, record_chat_turn
from app.core.orchestrator import Orchestrator, Turn
from app.db.audit_events_repository import get_audit_events_repository
from app.models.schemas import ChatRequest, ChatResponse

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
    if stream:
        return StreamingResponse(
            _stream_chat(req=req, who=who),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )
    started = perf_counter()
    turn = await _orch.handle(
        req.message, module=req.module, tenant_id=who.tenant_id,
        user_role=req.user_role or who.role, jurisdiction=req.jurisdiction,
        asset_context=req.asset_context, offline_mode=req.offline_mode,
        attachments=req.attachments,
    )
    latency_seconds = perf_counter() - started
    _finalize_chat_turn(req=req, turn=turn, who=who, latency_seconds=latency_seconds)
    return ChatResponse(answer=turn.answer, tool_results=turn.tool_results, flags=turn.flags,
                        citations=turn.citations)


async def _stream_chat(req: ChatRequest, who: Principal):
    started = perf_counter()
    final_data = None
    async for item in _orch.stream_handle(
        req.message, module=req.module, tenant_id=who.tenant_id,
        user_role=req.user_role or who.role, jurisdiction=req.jurisdiction,
        asset_context=req.asset_context, offline_mode=req.offline_mode,
        attachments=req.attachments,
    ):
        event = item["event"]
        data = item["data"]
        if event == "done":
            final_data = data
        yield _sse(event, data)
    if final_data is not None:
        turn = Turn(
            answer=final_data.get("answer", ""),
            tool_results=final_data.get("tool_results", []),
            flags=final_data.get("flags", []),
            audit=final_data.get("audit", {}),
        )
        _finalize_chat_turn(
            req=req,
            turn=turn,
            who=who,
            latency_seconds=perf_counter() - started,
        )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, sort_keys=True)}\n\n"


def _finalize_chat_turn(*, req: ChatRequest, turn: Turn, who: Principal,
                        latency_seconds: float) -> None:
    audit_logger.write(AuditEvent(
        event_type="chat_turn",
        tenant_id=who.tenant_id,
        user_id=who.user_id,
        role=who.role,
        route="/chat",
        request=req.model_dump(),
        response={"answer": turn.answer},
        flags=turn.flags,
        tool_results=turn.tool_results,
        metadata=turn.audit,
    ))
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
