"""
Permit-to-Work module - agent preamble + tool wiring.

The PTW module is decision support: the LLM helps draft a permit from
structured inputs, but the Permit Issuer and Performing Authority are
the authoritative actors. Every PTW response carries the verification
banner; the tool result's ``safety_critical`` flag drives the post-
guardrail banner check.
"""
from __future__ import annotations

from typing import Any

from .template import OUTPUT_FORMATS, WORK_TYPES, PtwInputs, build_ptw


MODULE_PREAMBLE = """\
<module>Permit to Work</module>
You are operating as PetroBrain's Permit-to-Work assistant. You help draft
permits and toolbox-talk briefings from structured job inputs (description,
location, work type, hazards, controls, isolations) supplied by the field
user.

Hard rules for this module, in addition to the base safety principles:
- You are decision SUPPORT only. The Permit Issuer and Performing Authority
  remain the authoritative signers; the permit you draft is unsigned and
  must be reviewed against the operator's PTW standard before issue.
- Permit content comes from the build_ptw_template tool. Do not invent
  permit numbers, dates, or sign-off blocks in prose.
- Hazards and controls you suggest are SUGGESTIONS. Highlight that the
  user must verify them against the operator's PTW standard and the
  current state of the work front.
- Always carry the verification banner the tool emits.
- Hot work, confined-space entry, working at height, and electrical work
  always require an isolation step and a rescue plan; flag this even if
  the user did not supply isolations.
"""


BUILD_PTW_TEMPLATE_TOOL: dict[str, Any] = {
    "name": "build_ptw_template",
    "description": (
        "Build a Permit-to-Work draft or a toolbox-talk briefing from the supplied "
        "job context (description, location, work type, hazards, controls, "
        "isolations). Returns a structured permit document with the verification "
        "banner. SAFETY-CRITICAL: decision support only - the Permit Issuer and "
        "Performing Authority sign before work begins."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "job_description": {"type": "string"},
            "location": {"type": "string"},
            "work_type": {"type": "string", "enum": list(WORK_TYPES)},
            "hazards": {"type": "array", "items": {"type": "string"}},
            "controls": {"type": "array", "items": {"type": "string"}},
            "isolations": {"type": "array", "items": {"type": "string"}},
            "required_ppe": {"type": "array", "items": {"type": "string"}},
            "issued_by": {"type": "string"},
            "performing_authority": {"type": "string"},
            "valid_from": {"type": "string"},
            "valid_to": {"type": "string"},
            "output_format": {"type": "string", "enum": list(OUTPUT_FORMATS)},
        },
        "required": ["job_description", "work_type", "location"],
    },
}


def run_build_ptw_template_tool(args: dict[str, Any]) -> dict[str, Any]:
    """Deterministic tool entrypoint the orchestrator calls when the LLM requests it."""
    inputs = PtwInputs(
        job_description=str(args["job_description"]),
        location=str(args["location"]),
        work_type=str(args["work_type"]),
        hazards=tuple(args.get("hazards") or ()),
        controls=tuple(args.get("controls") or ()),
        isolations=tuple(args.get("isolations") or ()),
        required_ppe=tuple(args.get("required_ppe") or ()),
        issued_by=_optional_str(args.get("issued_by")),
        performing_authority=_optional_str(args.get("performing_authority")),
        valid_from=_optional_str(args.get("valid_from")),
        valid_to=_optional_str(args.get("valid_to")),
        output_format=str(args.get("output_format") or "permit"),
    )
    return build_ptw(inputs)


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
