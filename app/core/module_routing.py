"""Deterministic chat-module routing from user intent."""
from __future__ import annotations

import re


VALID_MODULES = {
    "general",
    "research",
    "well_control",
    "emissions_mrv",
    "ptw",
}

_INSTRUCTION_BLOCK = re.compile(
    r"<(?:user|project)_instructions>.*?</(?:user|project)_instructions>",
    re.IGNORECASE | re.DOTALL,
)
_SPACE = re.compile(r"\s+")

_WELL_CONTROL = (
    re.compile(
        r"\b(?:create|prepare|build|generate|calculate|complete|make)\b"
        r".{0,50}\bkill\s+sheet\b"
    ),
)
_PTW = (
    re.compile(
        r"\b(?:create|prepare|build|generate|draft|make)\b"
        r".{0,50}\b(?:ptw|permit\s+to\s+work)\b"
    ),
)
_EMISSIONS = (
    re.compile(
        r"\b(?:calculate|compute|quantify|estimate|model)\b"
        r".{0,70}\b(?:flaring|flare|venting|fugitive|combustion|methane|ghg|"
        r"greenhouse\s+gas|co2e?)\b.{0,30}\bemissions?\b"
    ),
    re.compile(
        r"\b(?:calculate|compute|quantify|estimate|model)\b"
        r".{0,70}\bemissions?\b"
    ),
)
_RESEARCH = (
    re.compile(r"\bdeep\s+research\b"),
    re.compile(r"\bresearch\s+report\b"),
    re.compile(r"\binvestment\s+brief\b"),
    re.compile(r"\bregulatory\s+background\b"),
    re.compile(r"\bmarket\s+analysis\b"),
    re.compile(r"\bsector\s+overview\b"),
    re.compile(r"\bopportunity\s+brief\b"),
    re.compile(r"\bdue\s+diligence\b"),
    re.compile(r"\bcompliance\s+research\b"),
)


def route_module(user_text: str, requested_module: str = "general") -> str:
    """Return the effective module, preferring clear prompt intent.

    Operational requests have priority over research language so a request for
    a deterministic calculation or controlled template cannot be diverted into
    a prose-only research workflow.
    """
    text = _routing_text(user_text)
    for module, patterns in (
        ("well_control", _WELL_CONTROL),
        ("ptw", _PTW),
        ("emissions_mrv", _EMISSIONS),
        ("research", _RESEARCH),
    ):
        if any(pattern.search(text) for pattern in patterns):
            return module
    if "full overview" in text and re.search(
        r"\b(?:cite|cited|citation|citations|sources?|references?)\b",
        text,
    ):
        return "research"
    return requested_module if requested_module in VALID_MODULES else "general"


def _routing_text(user_text: str) -> str:
    text = _INSTRUCTION_BLOCK.sub(" ", user_text or "")
    text = text.lower().replace("-", " ").replace("_", " ")
    return _SPACE.sub(" ", text).strip()
