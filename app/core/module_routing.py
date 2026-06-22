"""Deterministic, explainable per-turn module routing."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any


VALID_MODULES = {
    "general",
    "research",
    "well_control",
    "emissions_mrv",
    "ptw",
    "documents",
    "tasks",
    "audit",
}

_INSTRUCTION_BLOCK = re.compile(
    r"<(?:user|project)_instructions>.*?</(?:user|project)_instructions>",
    re.IGNORECASE | re.DOTALL,
)
_SPACE = re.compile(r"\s+")

_PATTERNS: tuple[tuple[str, tuple[re.Pattern[str], ...]], ...] = (
    (
        "audit",
        tuple(
            re.compile(pattern)
            for pattern in (
                r"\baudit\s+trail\b",
                r"\b(?:admin|audit)\s+logs?\b",
                r"\b(?:bypass\s+attempts?|safety\s+flags|sources\s+used|tool\s+calls)\b",
            )
        ),
    ),
    (
        "tasks",
        tuple(
            re.compile(pattern)
            for pattern in (
                r"\b(?:remind|reminder|schedule|recurring)\b",
                r"\bcreate\b.{0,35}\btask\b",
                r"\b(?:weekly|monthly|quarterly|yearly)\b.{0,40}\b(?:task|reminder|digest|report)\b",
                r"\bcompliance\s+calendar\b",
            )
        ),
    ),
    (
        "well_control",
        tuple(
            re.compile(pattern)
            for pattern in (
                r"\bkill\s+sheet\b",
                r"\b(?:sidpp|sicp|maasp|kmw|fcp|bop)\b",
                r"\b(?:shut\s+in|shut-in|driller'?s\s+method|wait\s+and\s+weight)\b",
                r"\bwell\s+control\b",
                r"\b(?:kick|mud\s+weight|tvd)\b.{0,45}\b(?:well|kill|pressure|calculation)\b",
            )
        ),
    ),
    (
        "ptw",
        tuple(
            re.compile(pattern)
            for pattern in (
                r"\bpermit\s+to\s+work\b",
                r"\bptw\b",
                r"\b(?:hot\s+work|confined\s+space|working\s+at\s+height|loto)\b",
                r"\b(?:lifting\s+plan|excavation\s+permit|radiography)\b",
                r"\b(?:toolbox\s+talk|jsa|jha|hazards?\s+and\s+controls?)\b",
            )
        ),
    ),
    (
        "emissions_mrv",
        tuple(
            re.compile(pattern)
            for pattern in (
                r"\b(?:flaring|flare|venting|methane|co2e?|ghg|mrv)\b",
                r"\b(?:scope\s+[123]|ogmp|nuprc\s+tier\s*3|tier\s*3)\b",
                r"\b(?:combustion|fugitive)\s+emissions?\b",
                r"\b(?:abatement|ldar|methane\s+intensity)\b",
            )
        ),
    ),
    (
        "documents",
        tuple(
            re.compile(pattern)
            for pattern in (
                r"\bsummari[sz]e\s+(?:this|the)\s+(?:document|file|pdf|docx|spreadsheet)\b",
                r"\bextract\s+(?:the\s+)?obligations?\b",
                r"\bcompare\s+(?:these|the)\s+documents?\b",
                r"\bcite\s+(?:the\s+)?page\b",
                r"\bfrom\s+the\s+uploaded\s+file\b",
                r"\bthis\s+(?:pdf|docx|spreadsheet|uploaded\s+file)\b",
            )
        ),
    ),
    (
        "research",
        tuple(
            re.compile(pattern)
            for pattern in (
                r"\bdeep\s+research\b",
                r"\bresearch\s+report\b",
                r"\bfull\s+overview\b",
                r"\bsector\s+overview\b",
                r"\b(?:market|regulator|regulatory|licensing\s+round)\b",
                r"\b(?:investment\s+opportunit|company\s+profile|due\s+diligence)\w*\b",
                r"\bcompare\s+regulations?\b",
                r"\bwhat\s+are\s+people\s+saying\b",
                r"\b(?:latest|news|current)\b",
                r"\b(?:cite|cited|citation|citations|sources?|references?)\b",
                r"\bpolicy\b",
            )
        ),
    ),
)

_LABELS = {
    "general": "General",
    "research": "Research",
    "well_control": "Well Control",
    "emissions_mrv": "Emissions / MRV",
    "ptw": "PTW",
    "documents": "Documents",
    "tasks": "Tasks",
    "audit": "Audit",
}

_REASONS = {
    "research": "This request needs cited sector, regulator, market, or current-source analysis.",
    "well_control": "This request contains well-control calculations or terminology.",
    "emissions_mrv": "This request concerns emissions quantification or MRV.",
    "ptw": "This request concerns permit-to-work hazards, controls, or authorization.",
    "documents": "This request asks PetroBrain to analyze attached or uploaded documents.",
    "tasks": "This request creates or manages a compliance or operations task.",
    "audit": "This request queries the tenant audit trail.",
    "general": "No specialist workflow was clearly required.",
}


@dataclass(frozen=True)
class ModuleRouteDecision:
    selected_module_for_this_turn: str
    routing_confidence: str
    reason: str
    should_prompt_user: bool = False
    user_visible_notice: str | None = None
    safety_flags: list[str] = field(default_factory=list)
    detected_module: str | None = None
    requested_module: str = "general"
    module_pinned: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "selected_module_for_this_turn": self.selected_module_for_this_turn,
            "resolved_module": self.selected_module_for_this_turn,
            "routing_confidence": self.routing_confidence,
            "routing_reason": self.reason,
            "should_prompt_user": self.should_prompt_user,
            "user_visible_notice": self.user_visible_notice,
            "safety_flags": self.safety_flags,
            "detected_module": self.detected_module,
            "requested_module": self.requested_module,
            "module_pinned": self.module_pinned,
        }


class ModuleRouter:
    """Resolve every message unless the selected specialist is pinned."""

    def route(
        self,
        *,
        user_message: str,
        selected_module: str = "auto",
        auto_route_enabled: bool = True,
        module_pinned: bool = False,
        attachments: list[Any] | None = None,
        asset_context: str | None = None,
        conversation_context: list[dict[str, Any]] | None = None,
    ) -> ModuleRouteDecision:
        del asset_context, conversation_context  # Reserved for future scoring.
        requested = _normalize_selected_module(selected_module)
        detected, confidence = _detect_module(user_message, attachments or [])
        safety_flags = (
            ["safety_bypass_intent"]
            if re.search(r"\b(?:bypass|disable|defeat)\b.{0,35}\b(?:esd|bop|interlock|safety)\b",
                         _routing_text(user_message))
            else []
        )

        if module_pinned and requested != "auto":
            conflict = bool(detected) and detected != requested and confidence == "high"
            notice = None
            reason = f"{_LABELS[requested]} is pinned."
            if conflict:
                assert detected is not None  # conflict is only set when a module was detected
                notice = (
                    f"This question appears to match {_LABELS[detected]}, "
                    f"but {_LABELS[requested]} is pinned."
                )
                reason = f"{_REASONS[detected]} {_LABELS[requested]} remains pinned."
            return ModuleRouteDecision(
                selected_module_for_this_turn=requested,
                routing_confidence=confidence if detected else "low",
                reason=reason,
                user_visible_notice=notice,
                safety_flags=safety_flags,
                detected_module=detected,
                requested_module=requested,
                module_pinned=True,
            )

        automatic = requested == "auto" or auto_route_enabled
        if automatic and detected:
            changed = requested not in {"auto", detected}
            notice = (
                f"Switched to {_LABELS[detected]} for this turn."
                if changed
                else f"Routed to {_LABELS[detected]}."
            )
            return ModuleRouteDecision(
                selected_module_for_this_turn=detected,
                routing_confidence=confidence,
                reason=_REASONS[detected],
                user_visible_notice=notice,
                safety_flags=safety_flags,
                detected_module=detected,
                requested_module=requested,
            )

        resolved = "general" if requested == "auto" else requested
        return ModuleRouteDecision(
            selected_module_for_this_turn=resolved,
            routing_confidence="low",
            reason=_REASONS["general"] if requested == "auto" else (
                f"No clear cross-module match; keeping {_LABELS[resolved]}."
            ),
            safety_flags=safety_flags,
            detected_module=detected,
            requested_module=requested,
        )


def route_module(user_text: str, requested_module: str = "general") -> str:
    """Backward-compatible module-only API used by older callers."""
    return ModuleRouter().route(
        user_message=user_text,
        selected_module=requested_module,
        auto_route_enabled=True,
    ).selected_module_for_this_turn


def _detect_module(user_text: str, attachments: list[Any]) -> tuple[str | None, str]:
    text = _routing_text(user_text)
    attachment_present = bool(attachments)
    if attachment_present and (
        not text
        or re.search(
            r"\b(?:summari[sz]e|review|analy[sz]e|extract|compare|document|file|pdf|docx|spreadsheet)\b",
            text,
        )
    ):
        return "documents", "high"
    # Explicit research deliverables take priority over subject keywords. A
    # "deep research report on flare commercialization" is research, whereas
    # "calculate flare emissions" remains an emissions tool request.
    if re.search(
        r"\b(?:deep\s+research|research\s+report|full\s+overview|sector\s+overview|"
        r"due\s+diligence|company\s+profile|investment\s+opportunit)\w*\b",
        text,
    ):
        return "research", "high"
    for module, patterns in _PATTERNS:
        matches = sum(bool(pattern.search(text)) for pattern in patterns)
        if matches:
            return module, "high" if matches >= 1 else "medium"
    return None, "low"


def _normalize_selected_module(value: str) -> str:
    selected = (value or "auto").strip().lower()
    if selected == "auto":
        return selected
    return selected if selected in VALID_MODULES else "general"


def _routing_text(user_text: str) -> str:
    text = _INSTRUCTION_BLOCK.sub(" ", user_text or "")
    text = text.lower().replace("-", " ").replace("_", " ")
    return _SPACE.sub(" ", text).strip()
