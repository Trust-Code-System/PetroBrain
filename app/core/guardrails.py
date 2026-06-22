"""
Guardrails - the runtime safety layer from the engineering spec.

Two stages:
  pre  : domain lock, live-event routing, bypass-attempt refusal
  post : numeric-provenance check (numbers must come from a calc tool), citation
         check (cited clauses must exist in retrieved context), safety-banner check

In production the classifiers here are trained models; the regex/keyword versions
below are the deployable Phase-1 baseline and the test scaffold.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from app.modules.well_control.agent import detect_live_event, IMMEDIATE_ACTION


@dataclass
class GuardrailVerdict:
    allow: bool
    override_response: str | None = None   # if set, return this instead of calling the LLM
    reason: str | None = None
    flags: list[str] | None = None


@dataclass(frozen=True)
class SafetyEvent:
    rule: str
    severity: str
    category: str
    response: str


# Out-of-domain quick filter (the LLM also enforces domain lock; this is defense in depth)
_OFF_DOMAIN_HINTS = [
    r"\bwrite me a poem\b", r"\bmedical advice\b", r"\bwho should i vote\b",
    r"\brecipe\b", r"\bdating\b", r"\bhomework\b",
]

# Attempts to defeat a safety system - hard refuse
_SAFETY_RULES: tuple[tuple[str, str, str, tuple[str, ...]], ...] = (
    (
        "tenant_boundary_bypass",
        "critical",
        "security",
        (
            r"\b(?:access|search|reveal|show)\b.{0,45}\b(?:another|other|all)\s+tenants?\b",
            r"\breveal\b.{0,30}\banother tenant'?s (?:documents?|reports?|memory|audit)\b",
            r"\bignore tenant isolation\b",
        ),
    ),
    (
        "regulatory_falsification",
        "critical",
        "compliance",
        (
            r"\b(?:falsify|fake|understate|hide|remove)\b.{0,55}\b(?:emissions?|flaring|methane|nuprc|compliance data|regulatory filing|incident evidence|near miss)\b",
            r"\bsubmit false\b.{0,35}\b(?:report|filing|data)\b",
            r"\brewrite\b.{0,50}\b(?:emissions?|flaring)\b.{0,25}\b(?:smaller|lower|less)\b",
        ),
    ),
    (
        "critical_safety_system_bypass",
        "critical",
        "safety",
        (
            r"\b(?:bypass|disable|override|defeat|inhibit)\b.{0,30}\b(?:esd|sis|bop|fire and gas|f&g)\b",
            r"\boverride\b.{0,25}\bbop\b.{0,25}\b(?:kick|well control)\b",
        ),
    ),
    (
        "permit_or_interlock_bypass",
        "high",
        "safety",
        (
            r"\b(?:bypass|disable|override|defeat|inhibit)\b.{0,35}\b(?:shutdown|interlock|trip|alarm|gas detector|relief|safety system)\b",
            # Forcing/jamming a valve or actuator into a commanded state from the panel
            # bypasses the interlock/automatic control that governs it - refuse, same class
            # as defeating an interlock. ("force the valve open from the panel", etc.)
            r"\b(?:force|jam|wedge|jog|stroke)\b.{0,25}\b(?:valve|sdv|bdv|esdv|actuator|solenoid|damper)\b.{0,20}\b(?:open|close|closed|shut)\b",
            r"\bcontinue hot work\b.{0,30}\bwithout (?:a )?permit\b",
            r"\bfake\b.{0,20}\bptw\b.{0,20}\bsign[- ]?off\b",
        ),
    ),
    (
        "guardrail_or_audit_bypass",
        "high",
        "security",
        (
            r"\b(?:disable|remove|ignore|bypass)\b.{0,35}\b(?:guardrails?|safety banners?|audit logging|safety rules?)\b",
            r"\breveal (?:the )?(?:system prompt|hidden prompt|developer instructions)\b",
            r"\b(?:reveal|show|print|expose)\b.{0,30}\b(?:chain[- ]of[- ]thought|"
            r"private reasoning|hidden reasoning|internal reasoning)\b",
            r"\bignore previous instructions\b.{0,35}\b(?:guardrails?|system prompt|safety)\b",
        ),
    ),
)


def pre_check(user_text: str) -> GuardrailVerdict:
    t = user_text.lower()
    safety_event = detect_safety_event(user_text)
    if safety_event:
        return GuardrailVerdict(
            allow=False,
            override_response=safety_event.response,
            reason="bypass_attempt",
            flags=["safety_bypass"],
        )
    if detect_live_event(user_text):
        # let the answer proceed, but lead with immediate action
        return GuardrailVerdict(allow=True, override_response=IMMEDIATE_ACTION,
                                reason="live_event", flags=["live_event"])
    if any(re.search(p, t) for p in _OFF_DOMAIN_HINTS):
        return GuardrailVerdict(
            allow=False,
            override_response=(
                "I'm built specifically for oil & gas work, so I can't help with that - "
                "but anything across drilling, production, processing, integrity, HSE or "
                "the commercial side, I'm all yours."
            ),
            reason="off_domain", flags=["off_domain"],
        )
    return GuardrailVerdict(allow=True)


def detect_safety_event(user_text: str) -> SafetyEvent | None:
    text = " ".join((user_text or "").lower().split())
    for rule, severity, category, patterns in _SAFETY_RULES:
        if any(re.search(pattern, text) for pattern in patterns):
            return SafetyEvent(
                rule=rule,
                severity=severity,
                category=category,
                response=_refusal_for(category),
            )
    return None


def _refusal_for(category: str) -> str:
    if category == "compliance":
        return (
            "I can't help falsify, conceal, or understate emissions, incident, or "
            "regulatory data. This request has been refused, logged, and escalated "
            "for compliance review. I can help reconcile the figures, investigate "
            "measurement errors, prepare a transparent correction note, or build an "
            "evidence-backed report."
        )
    if category == "security":
        return (
            "I can't disclose another tenant's data, reveal protected system "
            "instructions, or disable audit and security controls. This access or "
            "bypass attempt has been refused, logged, and escalated for admin review."
        )
    return (
        "I can't help bypass, disable, or override an ESD, SIS, fire-and-gas, BOP, "
        "alarm, trip, interlock, permit, or other safety control. This safety-critical "
        "request has been refused, logged, and escalated for admin review. Follow the "
        "site emergency or stop-work procedure and contact the responsible supervisor "
        "or competent authority."
    )


def post_check(answer_text: str, *, numbers_from_tools: bool,
               cited_clauses: list[str], retrieved_clauses: list[str],
               safety_critical: bool) -> GuardrailVerdict:
    flags: list[str] = []
    # Numbers presented as results must originate from a calc tool call.
    if re.search(r"\b\d{2,}\s?(psi|ppg|bbl|scf|tonnes?|stb)", answer_text.lower()) and not numbers_from_tools:
        flags.append("unverified_numeric")
    # Cited clauses must exist in retrieved context (no fabricated references).
    fabricated = [c for c in cited_clauses if c not in retrieved_clauses]
    if fabricated:
        flags.append(f"fabricated_citation:{fabricated}")
    # Safety-critical answers must carry a verification reminder.
    if safety_critical and "verify" not in answer_text.lower() and "competent person" not in answer_text.lower():
        flags.append("missing_safety_banner")
    return GuardrailVerdict(allow=not flags, reason="post_check", flags=flags or None)
