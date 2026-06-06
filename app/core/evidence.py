"""User-safe evidence packs for chat answers."""
from __future__ import annotations

from typing import Any


_TOOL_LABELS = {
    "build_kill_sheet": "Kill sheet calculation",
    "build_ptw_template": "Permit template",
    "build_ghgemp_report": "GHGEMP report",
    "build_report": "Emissions report",
    "flaring_emissions": "Flaring emissions calculation",
    "venting_emissions": "Venting emissions calculation",
    "fugitive_tier2": "Fugitive emissions estimate",
    "fugitive_tier3": "Fugitive emissions estimate",
    "combustion_emissions": "Combustion emissions calculation",
    "reconcile_flaring": "Flaring reconciliation",
    "model_abatement": "Abatement model",
}

_SKIP_OUTPUT_KEYS = {
    "banner",
    "working",
    "notes",
    "sources",
    "source_table",
    "next_actions",
    "warnings",
    "assumptions",
}


def build_evidence_pack(
    *,
    citations: list[dict[str, Any]] | None,
    tool_results: list[dict[str, Any]] | None,
    flags: list[str] | None,
    module: str,
    offline_mode: bool = False,
    disable_web_search: bool = False,
) -> dict[str, Any]:
    citations = citations or []
    tool_results = tool_results or []
    flags = flags or []
    sources = _source_entries(citations)
    calculations = _calculation_entries(tool_results)
    not_verified = _not_verified_notes(
        citations=citations,
        tool_results=tool_results,
        flags=flags,
        offline_mode=offline_mode,
        disable_web_search=disable_web_search,
    )
    confidence = _confidence_label(
        sources=sources,
        calculations=calculations,
        not_verified=not_verified,
        flags=flags,
    )
    safety_required = any(
        isinstance(tr.get("result"), dict)
        and (
            tr["result"].get("safety_critical") is True
            or isinstance(tr["result"].get("banner"), str)
        )
        for tr in tool_results
    ) or any(flag in {"live_event", "missing_safety_banner"} for flag in flags)
    checked = _checked_summary(
        sources=sources,
        calculations=calculations,
        module=module,
        offline_mode=offline_mode,
    )
    return {
        "confidence": confidence,
        "checked": checked,
        "not_verified": not_verified,
        "sources": sources,
        "calculations": calculations,
        "safety": {
            "requires_human_verification": safety_required,
            "message": (
                "Verify safety-critical outputs with the competent person before action."
                if safety_required else ""
            ),
        },
    }


def _source_entries(citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for citation in citations:
        url = citation.get("url")
        source_type = "web" if isinstance(url, str) and url else "document"
        title = _safe_text(citation.get("title")) or ("Current source" if source_type == "web" else "Uploaded document")
        revision = _safe_text(citation.get("revision"))
        clause = _safe_text(citation.get("clause"))
        source_id = _safe_text(citation.get("source_id"))
        reliability = _safe_text(citation.get("reliability"))
        key = (source_type, title, revision or "", clause or "")
        if key in seen:
            continue
        seen.add(key)
        entry = {
            "type": source_type,
            "label": _source_label(
                title=title,
                revision=revision,
                clause=clause,
                source_id=source_id,
                reliability=reliability,
            ),
        }
        if source_type == "web":
            entry["url"] = url
        out.append(entry)
    return out[:8]


def _calculation_entries(tool_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for tr in tool_results:
        tool = tr.get("tool")
        if tool == "web_search" or not isinstance(tool, str):
            continue
        result = tr.get("result")
        if not isinstance(result, dict):
            continue
        outputs = [
            {"label": _humanize_key(k), "value": v}
            for k, v in result.items()
            if k not in _SKIP_OUTPUT_KEYS and isinstance(v, (str, int, float, bool))
        ][:6]
        working = result.get("working")
        formulas = [
            str(step)
            for step in (working if isinstance(working, list) else [])
            if isinstance(step, (str, int, float))
        ][:4]
        out.append({
            "label": _TOOL_LABELS.get(tool, "Deterministic calculation"),
            "outputs": outputs,
            "formulas": formulas,
        })
    return out[:6]


def _not_verified_notes(
    *,
    citations: list[dict[str, Any]],
    tool_results: list[dict[str, Any]],
    flags: list[str],
    offline_mode: bool,
    disable_web_search: bool,
) -> list[str]:
    notes: list[str] = []
    if not any(not c.get("url") for c in citations):
        notes.append("No uploaded SOP or procedure citation was used.")
    web_checked = any(tr.get("tool") == "web_search" for tr in tool_results)
    if offline_mode or disable_web_search:
        notes.append("Current external sources were not checked.")
    elif not web_checked:
        notes.append("Current external sources were not needed or not checked.")
    if "unverified_numbers" in flags:
        notes.append("Some numbers need deterministic calculation or source confirmation.")
    if "missing_safety_banner" in flags:
        notes.append("Safety-critical wording needs competent-person verification.")
    return _dedupe(notes)


def _checked_summary(
    *,
    sources: list[dict[str, Any]],
    calculations: list[dict[str, Any]],
    module: str,
    offline_mode: bool,
) -> list[str]:
    checked: list[str] = []
    if sources:
        checked.append(f"{len(sources)} source{'' if len(sources) == 1 else 's'} attached to the answer.")
    if calculations:
        checked.append(f"{len(calculations)} deterministic calculation{'' if len(calculations) == 1 else 's'} used.")
    if offline_mode:
        checked.append("Offline-mode constraints applied.")
    if not checked:
        checked.append(f"Answered from the {module.replace('_', ' ')} assistant context.")
    return checked


def _confidence_label(
    *,
    sources: list[dict[str, Any]],
    calculations: list[dict[str, Any]],
    not_verified: list[str],
    flags: list[str],
) -> dict[str, str]:
    serious_flags = {"unverified_numbers", "missing_safety_banner", "llm_configuration_error"}
    if serious_flags.intersection(flags):
        return {"label": "Needs verification", "reason": "Important checks are incomplete."}
    if sources and calculations and not not_verified:
        return {"label": "High", "reason": "Sources and deterministic calculations support the answer."}
    if sources or calculations:
        return {"label": "Medium", "reason": "Some supporting evidence is present, with noted gaps."}
    return {"label": "Low", "reason": "No external source or deterministic calculation was attached."}


def _source_label(
    *,
    title: str,
    revision: str | None,
    clause: str | None,
    source_id: str | None = None,
    reliability: str | None = None,
) -> str:
    parts = [source_id, title] if source_id else [title]
    if revision:
        parts.append(revision)
    if clause:
        parts.append(f"section {clause}")
    if reliability:
        parts.append(f"{reliability} reliability")
    return " - ".join(parts)


def _humanize_key(key: str) -> str:
    return (
        key.replace("_", " ")
        .title()
        .replace("Ppg", "ppg")
        .replace("Psi", "psi")
        .replace("Co2", "CO2")
        .replace("Ch4", "CH4")
    )


def _safe_text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _dedupe(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out
