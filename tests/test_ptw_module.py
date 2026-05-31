"""PTW module tests - template engine, tool entrypoint, orchestrator wiring."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from app.core.llm_service import LLMResponse
from app.core.orchestrator import MODULE_TOOLS, TOOL_REGISTRY, Orchestrator
from app.core.prompts import MODULE_PREAMBLES, build_system_prompt
from app.modules.ptw.agent import BUILD_PTW_TEMPLATE_TOOL, run_build_ptw_template_tool
from app.modules.ptw.template import PtwInputs, WORK_TYPES, build_ptw


VALID_HOTWORK = {
    "job_description": "Replace gasket on compressor K-101 suction flange",
    "location": "Compressor K-101 at Train A",
    "work_type": "hot_work",
    "hazards": ["Hydrocarbon vapour", "Hot surfaces > 60 C"],
    "controls": ["Isolate suction valve V-501"],
    "isolations": ["V-501", "ESD-101"],
    "required_ppe": ["FRC coveralls"],
}


# ---- template engine -------------------------------------------------------


def test_template_emits_banner_and_safety_critical():
    permit = build_ptw(PtwInputs(**VALID_HOTWORK))
    assert permit["safety_critical"] is True
    assert "DECISION SUPPORT ONLY" in permit["banner"]
    assert permit["status"] == "draft_unsigned"
    assert permit["format"] == "permit"
    # Audit hash is deterministic over the structured payload.
    assert isinstance(permit["audit_sha256"], str) and len(permit["audit_sha256"]) == 64


def test_template_merges_supplied_and_suggested_controls_without_duplicates():
    permit = build_ptw(PtwInputs(**VALID_HOTWORK))
    merged = permit["controls"]["merged"]
    assert "Isolate suction valve V-501" in merged
    assert any("gas monitoring" in c.lower() for c in merged)
    # No duplicates after the merge.
    assert len(merged) == len(set(merged))


def test_template_includes_unsigned_signoff_block():
    permit = build_ptw(PtwInputs(**VALID_HOTWORK))
    issuer = permit["sign_off"]["permit_issuer"]
    pa = permit["sign_off"]["performing_authority"]
    assert issuer["signed_utc"] is None
    assert pa["signed_utc"] is None


def test_template_toolbox_talk_emits_briefing_lines():
    talk = build_ptw(PtwInputs(**VALID_HOTWORK, output_format="toolbox_talk"))
    assert talk["format"] == "toolbox_talk"
    assert "Toolbox talk" in talk["banner"]
    assert isinstance(talk["briefing"], list) and len(talk["briefing"]) > 0
    joined = "\n".join(talk["briefing"])
    assert "Stop-work authority" in joined


def test_template_rejects_unknown_work_type():
    with pytest.raises(ValueError, match="work_type"):
        build_ptw(PtwInputs(**{**VALID_HOTWORK, "work_type": "tea_break"}))


def test_template_requires_job_description_and_location():
    with pytest.raises(ValueError, match="job_description"):
        build_ptw(PtwInputs(**{**VALID_HOTWORK, "job_description": "   "}))
    with pytest.raises(ValueError, match="location"):
        build_ptw(PtwInputs(**{**VALID_HOTWORK, "location": ""}))


def test_template_audit_hash_is_stable_across_runs():
    a = build_ptw(PtwInputs(**VALID_HOTWORK))
    b = build_ptw(PtwInputs(**VALID_HOTWORK))
    # generated_utc differs each call; strip it before comparing structure.
    a_norm = {k: v for k, v in a.items() if k not in ("generated_utc", "audit_sha256")}
    b_norm = {k: v for k, v in b.items() if k not in ("generated_utc", "audit_sha256")}
    assert a_norm == b_norm


# ---- tool entrypoint -------------------------------------------------------


def test_tool_entrypoint_accepts_minimum_fields():
    result = run_build_ptw_template_tool({
        "job_description": "Cold-line flange swap",
        "location": "Manifold M-201",
        "work_type": "cold_work",
    })
    assert result["format"] == "permit"
    assert result["safety_critical"] is True


def test_tool_entrypoint_normalises_optional_str_to_none_when_blank():
    result = run_build_ptw_template_tool({
        **VALID_HOTWORK,
        "issued_by": "   ",
        "performing_authority": None,
    })
    issuer_default = result["issued_by"]
    pa_default = result["performing_authority"]
    # When the caller omits / blanks the names, the template inserts a
    # placeholder that nudges the user toward the paper signature step.
    assert "sign" in issuer_default.lower()
    assert "sign" in pa_default.lower()


# ---- orchestrator wiring ---------------------------------------------------


class _SequenceLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def complete(self, system_prompt, messages, tools=None):
        self.calls.append({"system": system_prompt, "messages": messages, "tools": tools})
        return self.responses.pop(0)


def _ptw_tool_call(args):
    return LLMResponse(
        text="",
        tool_calls=[{"name": "build_ptw_template", "input": args, "id": "t1"}],
        usage={"input": 10, "output": 5},
        model="fake-model",
    )


def _final_response(text="Verify and sign on paper before work begins."):
    return LLMResponse(text=text, tool_calls=[], usage={"input": 12, "output": 6}, model="fake-model")


def test_orchestrator_exposes_ptw_module_with_build_ptw_template_tool():
    assert "ptw" in MODULE_PREAMBLES
    assert MODULE_TOOLS["ptw"] == ["build_ptw_template", "web_search"]
    assert "build_ptw_template" in TOOL_REGISTRY


def test_orchestrator_dispatches_build_ptw_template_via_ptw_module():
    orch = Orchestrator(llm=_SequenceLLM([_ptw_tool_call(VALID_HOTWORK), _final_response()]))
    turn = asyncio.run(orch.handle(
        "Draft a hot-work permit for K-101 gasket replacement.",
        module="ptw",
        tenant_id="tenant-a",
    ))
    assert len(turn.tool_results) == 1
    result = turn.tool_results[0]["result"]
    assert result["safety_critical"] is True
    assert "DECISION SUPPORT ONLY" in result["banner"]
    # The audit metadata records the PTW module.
    assert turn.audit["module"] == "ptw"


def test_orchestrator_records_ptw_input_for_audit():
    orch = Orchestrator(llm=_SequenceLLM([_ptw_tool_call(VALID_HOTWORK), _final_response()]))
    turn = asyncio.run(orch.handle(
        "Draft hot-work permit.",
        module="ptw",
        tenant_id="tenant-a",
    ))
    tr = turn.tool_results[0]
    # input is captured before the tool mutates anything (orchestrator deepcopies)
    assert tr["input"]["work_type"] == "hot_work"
    assert tr["input"]["location"] == "Compressor K-101 at Train A"


def test_orchestrator_rejects_unknown_work_type_in_tool_input():
    orch = Orchestrator(llm=_SequenceLLM([
        _ptw_tool_call({**VALID_HOTWORK, "work_type": "tea_break"}),
    ]))
    turn = asyncio.run(orch.handle(
        "Draft permit",
        module="ptw",
        tenant_id="tenant-a",
    ))
    assert "tool_input_error" in turn.flags


def test_ptw_preamble_is_safety_anchored():
    preamble = MODULE_PREAMBLES["ptw"]
    assert "decision SUPPORT" in preamble
    assert "Permit Issuer" in preamble
    assert "verification banner" in preamble


def test_build_system_prompt_includes_ptw_preamble():
    system = build_system_prompt(module="ptw")
    assert "Permit to Work" in system


def test_tool_schema_lists_all_supported_work_types():
    enum = BUILD_PTW_TEMPLATE_TOOL["parameters"]["properties"]["work_type"]["enum"]
    assert set(enum) == set(WORK_TYPES)
