"""
Permit-to-Work template engine.

Given structured inputs (job description, work type, hazards, controls,
isolations, ...), emits a permit document or a toolbox-talk briefing as
a deterministic dict. The LLM never invents the structure - the
orchestrator calls this tool, then composes the natural-language
wrapper around the returned permit blocks.

The output is decision-support, never authoritative. Every emitted
permit carries the verification banner and an unsigned sign-off block;
the Permit Issuer and Performing Authority must sign on paper / in the
PTW system before work begins.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


WORK_TYPES = (
    "hot_work",
    "cold_work",
    "confined_space",
    "working_at_height",
    "electrical",
    "excavation",
    "diving",
    "radiography",
    "lifting",
)

OUTPUT_FORMATS = ("permit", "toolbox_talk")

# Conservative suggested controls per work type. The tool returns these
# alongside any controls the caller already supplied; the field UI shows
# them as suggestions for the engineer to accept or reject. They are NOT
# a substitute for the operator's own PTW standard - production deploys
# overwrite them with the tenant's gazetted list.
SUGGESTED_CONTROLS: dict[str, tuple[str, ...]] = {
    "hot_work": (
        "Continuous gas monitoring in the work area (HC + O2 + H2S).",
        "Establish a competent fire watch with extinguishing media within reach.",
        "Isolate adjacent hydrocarbon equipment and drain/depressurise.",
        "Remove or shield combustible materials in a 10 m radius.",
        "Brief the fire watch on retention time (≥30 min after work completion).",
    ),
    "cold_work": (
        "Verify isolations and zero-energy state.",
        "Use only intrinsically-safe tools in classified areas.",
        "Maintain housekeeping and trip-hazard control.",
    ),
    "confined_space": (
        "Confined-space entry permit with continuous atmospheric monitoring.",
        "Trained attendant stationed at the entry point.",
        "Rescue plan briefed; retrieval equipment on standby.",
        "Communication maintained with the entrant at all times.",
    ),
    "working_at_height": (
        "Full-body harness with double lanyard, anchored above shoulder height.",
        "Inspect fall arrest equipment before each shift.",
        "Establish a drop zone and exclusion barrier below.",
        "Rescue plan for a suspended worker briefed.",
    ),
    "electrical": (
        "Lock-out / tag-out at every isolation point.",
        "Verify zero energy with an attempted start.",
        "Arc-flash PPE per the prepared boundary calculation.",
    ),
    "excavation": (
        "Underground services survey reviewed and witnessed on site.",
        "Shoring / battering per soil classification.",
        "Spotter for plant within 1.5 m of the excavation edge.",
    ),
    "diving": (
        "Authorised diving contractor; supervisor on dive station.",
        "Decompression plan and hyperbaric chamber availability confirmed.",
    ),
    "radiography": (
        "Restricted area established with the calculated boundary.",
        "Personal dosimeters issued and pre-job briefed.",
        "Source recovery procedure rehearsed.",
    ),
    "lifting": (
        "Lift plan signed by the Lifting Supervisor.",
        "Slings + shackles inspected within currency.",
        "Tag lines on loads; no personnel under the load path.",
    ),
}

# Minimum PPE per work type. Suggestions only.
SUGGESTED_PPE: dict[str, tuple[str, ...]] = {
    "hot_work": ("FRC coveralls", "Welding shield", "Gas-tight gloves", "Hearing protection"),
    "cold_work": ("Coveralls", "Safety glasses", "Cut-resistant gloves", "Hard hat"),
    "confined_space": ("BA/SCBA", "Harness with retrieval line", "Communications headset"),
    "working_at_height": ("Full-body harness", "Helmet with chin strap", "Anti-trauma loops"),
    "electrical": ("Arc-flash suit (per study)", "Insulated gloves with leather cover"),
    "excavation": ("Hi-vis", "Steel-toe boots", "Hard hat"),
    "diving": ("Per dive contractor PPE matrix",),
    "radiography": ("Personal dosimeter", "Survey meter"),
    "lifting": ("Hi-vis", "Hard hat", "Steel-toe boots"),
}


VERIFICATION_BANNER = (
    "DECISION SUPPORT ONLY. This is a draft permit. The Permit Issuer and "
    "Performing Authority must verify hazards, controls, and isolations against "
    "the operator's PTW standard and sign before work begins. Confirm gas tests, "
    "isolation verification, and rescue arrangements physically on site."
)

TOOLBOX_TALK_BANNER = (
    "Toolbox talk - read this aloud at the morning briefing. Confirm everyone "
    "present has understood the hazards, controls, and stop-work authority "
    "before deployment."
)


@dataclass(frozen=True)
class PtwInputs:
    job_description: str
    work_type: str
    location: str
    hazards: tuple[str, ...] = field(default_factory=tuple)
    controls: tuple[str, ...] = field(default_factory=tuple)
    isolations: tuple[str, ...] = field(default_factory=tuple)
    required_ppe: tuple[str, ...] = field(default_factory=tuple)
    issued_by: str | None = None
    performing_authority: str | None = None
    valid_from: str | None = None
    valid_to: str | None = None
    output_format: str = "permit"

    def __post_init__(self) -> None:
        if not self.job_description.strip():
            raise ValueError("job_description is required")
        if not self.location.strip():
            raise ValueError("location is required")
        if self.work_type not in WORK_TYPES:
            raise ValueError(
                f"work_type must be one of {sorted(WORK_TYPES)}, got {self.work_type!r}"
            )
        if self.output_format not in OUTPUT_FORMATS:
            raise ValueError(
                f"output_format must be one of {sorted(OUTPUT_FORMATS)}, got {self.output_format!r}"
            )


def build_ptw(inputs: PtwInputs) -> dict[str, Any]:
    """Build a structured permit document. Pure deterministic - no LLM."""
    suggested_controls = SUGGESTED_CONTROLS.get(inputs.work_type, ())
    suggested_ppe = SUGGESTED_PPE.get(inputs.work_type, ())

    controls = _merge_unique(inputs.controls, suggested_controls)
    ppe = _merge_unique(inputs.required_ppe, suggested_ppe)
    hazards = list(inputs.hazards)
    isolations = list(inputs.isolations)

    body = {
        "permit_id": f"PTW-DRAFT-{_short_hash(inputs)}",
        "work_type": inputs.work_type,
        "location": inputs.location,
        "job_description": inputs.job_description,
        "issued_by": inputs.issued_by or "Permit Issuer (sign on paper / in PTW system)",
        "performing_authority": (
            inputs.performing_authority
            or "Performing Authority (sign on paper / in PTW system)"
        ),
        "valid_from": inputs.valid_from,
        "valid_to": inputs.valid_to,
        "hazards": hazards,
        "controls": {
            "supplied": list(inputs.controls),
            "suggested": list(suggested_controls),
            "merged": controls,
        },
        "isolations": isolations,
        "required_ppe": {
            "supplied": list(inputs.required_ppe),
            "suggested": list(suggested_ppe),
            "merged": ppe,
        },
        "sign_off": {
            "permit_issuer": {"name": inputs.issued_by, "signed_utc": None},
            "performing_authority": {
                "name": inputs.performing_authority,
                "signed_utc": None,
            },
        },
        "status": "draft_unsigned",
        "generated_utc": datetime.now(timezone.utc).isoformat(),
    }

    if inputs.output_format == "permit":
        result = {
            **body,
            "format": "permit",
            "banner": VERIFICATION_BANNER,
            "safety_critical": True,
        }
    else:
        # Toolbox-talk: short morning briefing variant - same data, presented
        # as bullet points with explicit stop-work prompt.
        result = {
            **body,
            "format": "toolbox_talk",
            "banner": TOOLBOX_TALK_BANNER,
            "safety_critical": True,
            "briefing": _build_toolbox_talk(
                inputs.job_description,
                inputs.location,
                inputs.work_type,
                hazards,
                controls,
            ),
        }

    result["audit_sha256"] = _audit_hash(result)
    return result


def _merge_unique(supplied: tuple[str, ...] | list[str], suggested: tuple[str, ...]) -> list[str]:
    seen: dict[str, None] = {}
    for item in list(supplied) + list(suggested):
        item = item.strip()
        if item and item not in seen:
            seen[item] = None
    return list(seen.keys())


def _build_toolbox_talk(
    job: str,
    location: str,
    work_type: str,
    hazards: list[str],
    controls: list[str],
) -> list[str]:
    lines: list[str] = [
        f"Today's job: {job} at {location} ({work_type.replace('_', ' ')}).",
        "Top hazards we're managing:",
    ]
    for hazard in hazards[:5]:
        lines.append(f"  • {hazard}")
    lines.append("Controls in place:")
    for control in controls[:5]:
        lines.append(f"  • {control}")
    lines.append(
        "Stop-work authority is everyone's. If something looks off, stop the job and "
        "raise it with the Permit Issuer before continuing."
    )
    return lines


def _audit_hash(payload: dict[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, default=str).encode()
    return hashlib.sha256(blob).hexdigest()


def _short_hash(inputs: PtwInputs) -> str:
    blob = json.dumps(
        {
            "job": inputs.job_description,
            "loc": inputs.location,
            "wt": inputs.work_type,
            "h": list(inputs.hazards),
            "c": list(inputs.controls),
            "i": list(inputs.isolations),
        },
        sort_keys=True,
    ).encode()
    return hashlib.sha256(blob).hexdigest()[:8]
