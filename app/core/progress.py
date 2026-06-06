"""Safe, typed progress events for chat SSE streams.

Progress messages describe observable pipeline operations only. They must
never contain prompts, model reasoning, retrieved snippets, or chain-of-thought.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any


PROGRESS_EVENT_TYPES = {
    "status",
    "research_plan",
    "source_search_started",
    "source_found",
    "source_filtered",
    "retrieval_started",
    "retrieval_completed",
    "tool_call_started",
    "tool_call_completed",
    "citation_check_started",
    "citation_check_completed",
    "safety_check_started",
    "safety_check_completed",
    "evidence_pack_started",
    "evidence_pack_completed",
    "synthesis_started",
    "token",
    "final",
    "done",
    "error",
    "routing",
}


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProgressEmitter:
    """Build stream records with a consistent public event envelope."""

    def __init__(self, module: str) -> None:
        self.module = module

    def event(
        self,
        event_type: str,
        step_id: str,
        message: str,
        status: str = "running",
        *,
        metadata: dict[str, Any] | None = None,
        source: dict[str, Any] | None = None,
        confidence: dict[str, Any] | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        data: dict[str, Any] = {
            "type": event_type,
            "message": message,
            "step_id": step_id,
            "status": status,
            "timestamp": utc_timestamp(),
        }
        if metadata:
            data["metadata"] = metadata
        if source:
            data["source"] = source
        if confidence:
            data["confidence"] = confidence
        data.update(extra)
        return {"event": event_type, "data": data}

    def status(
        self,
        step_id: str,
        message: str,
        status: str = "running",
        **kwargs: Any,
    ) -> dict[str, Any]:
        return self.event("status", step_id, message, status, **kwargs)


def normalize_stream_data(event_type: str, data: dict[str, Any]) -> dict[str, Any]:
    """Add the typed envelope to legacy token/tool/citation/flag events."""
    normalized = dict(data)
    normalized.setdefault("type", event_type)
    normalized.setdefault("step_id", _default_step_id(event_type))
    normalized.setdefault("status", _default_status(event_type))
    normalized.setdefault("message", _default_message(event_type))
    normalized.setdefault("timestamp", utc_timestamp())
    return normalized


def _default_step_id(event_type: str) -> str:
    return {
        "token": "synthesis",
        "final": "finalize",
        "done": "done",
        "error": "error",
        "tool_call": "tool",
        "tool_result": "tool",
        "citation": "citations",
        "flag": "safety",
        "routing": "routing",
    }.get(event_type, event_type)


def _default_status(event_type: str) -> str:
    if event_type in {"done", "final", "tool_result", "citation"}:
        return "completed"
    if event_type == "error":
        return "failed"
    return "running"


def _default_message(event_type: str) -> str:
    return {
        "token": "Drafting final answer...",
        "final": "Final response prepared.",
        "done": "Completed response.",
        "error": "The response could not be completed.",
        "tool_call": "Running a deterministic check...",
        "tool_result": "Deterministic check completed.",
        "citation": "Source added.",
        "flag": "Safety check updated.",
        "routing": "Module selected.",
    }.get(event_type, "Working...")
