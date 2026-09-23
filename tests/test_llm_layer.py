"""
LLM/orchestrator production-readiness tests.

These use fakes only. They verify provider configuration errors are explicit and that
deterministic tool calls are parsed and dispatched safely without external LLM calls.
"""
import asyncio
import json
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from app.core.llm_service import LLMConfigurationError, LLMResponse, LLMService, _parse_tool_arguments
from app.core.orchestrator import Orchestrator


class SequenceLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def complete(self, system_prompt, messages, tools=None):
        self.calls.append({"system": system_prompt, "messages": messages, "tools": tools})
        if not self.responses:
            raise AssertionError("unexpected extra LLM call")
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def kill_sheet_tool_call(tool_input):
    return LLMResponse(
        text="",
        tool_calls=[{"name": "build_kill_sheet", "input": tool_input, "id": "tool-1"}],
        usage={"input": 10, "output": 5},
        model="fake-model",
    )


def final_response(text="Verify with the competent person before action."):
    return LLMResponse(text=text, tool_calls=[], usage={"input": 12, "output": 6}, model="fake-model")


def valid_kill_sheet_input():
    return {
        "tvd_ft": 10000,
        "md_ft": 10000,
        "omw_ppg": 9.6,
        "sidpp_psi": 400,
        "sicp_psi": 600,
        "pit_gain_bbl": 20,
        "scr_pressure_psi": 800,
        "pump_output_bbl_per_stk": 0.1,
        "drill_string_volume_bbl": 120,
        "annulus_volume_bit_to_surface_bbl": 180,
        "annular_capacity_bbl_per_ft": 0.0459,
        "shoe_tvd_ft": 5000,
        "max_allowable_mw_ppg": 14,
        "method": "wait_and_weight",
    }


def test_parse_tool_arguments_accepts_dict_and_json_object():
    assert _parse_tool_arguments({"a": 1}) == {"a": 1}
    assert _parse_tool_arguments('{"a": 1}') == {"a": 1}
    assert _parse_tool_arguments("") == {}


def test_parse_tool_arguments_rejects_non_object_json():
    with pytest.raises(ValueError, match="must decode to an object"):
        _parse_tool_arguments("[1, 2]")


def test_llm_service_requires_anthropic_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    service = LLMService()
    service.settings = SimpleNamespace(llm_provider="anthropic", llm_api_base="")

    with pytest.raises(LLMConfigurationError, match="ANTHROPIC_API_KEY is required"):
        service._validate_provider_config("anthropic")


def test_llm_service_requires_openai_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    service = LLMService()
    service.settings = SimpleNamespace(llm_provider="openai", llm_api_base="")

    with pytest.raises(LLMConfigurationError, match="OPENAI_API_KEY is required"):
        service._validate_provider_config("openai")


def test_llm_service_requires_self_hosted_base_url():
    service = LLMService()
    service.settings = SimpleNamespace(llm_provider="self_hosted", llm_api_base="")

    with pytest.raises(LLMConfigurationError, match="PB_LLM_API_BASE is required"):
        service._validate_provider_config("self_hosted")


def test_orchestrator_returns_explicit_llm_config_error():
    orch = Orchestrator(llm=SequenceLLM([LLMConfigurationError("missing key")]))

    turn = asyncio.run(orch.handle("Explain ESP troubleshooting", tenant_id="tenant-a"))

    assert "LLM provider is not configured" in turn.answer
    assert "llm_configuration_error" in turn.flags
    assert turn.audit["stopped_at"] == "llm_config"


def test_orchestrator_rejects_unknown_tool_call():
    response = LLMResponse(
        text="",
        tool_calls=[{"name": "invent_pressure", "input": {}, "id": "bad-tool"}],
        usage={},
        model="fake-model",
    )
    orch = Orchestrator(llm=SequenceLLM([response]))

    turn = asyncio.run(orch.handle("Build a kill sheet", module="well_control", tenant_id="tenant-a"))

    assert "unavailable tool" in turn.answer
    assert "unknown_tool_call" in turn.flags
    assert turn.audit["stopped_at"] == "tool_dispatch"


def test_orchestrator_accepts_json_string_tool_input_and_records_tool_result():
    tool_input = json.dumps(valid_kill_sheet_input())
    orch = Orchestrator(llm=SequenceLLM([kill_sheet_tool_call(tool_input), final_response()]))

    turn = asyncio.run(orch.handle("Build a kill sheet", module="well_control", tenant_id="tenant-a"))

    assert len(turn.tool_results) == 1
    result = turn.tool_results[0]["result"]
    assert result["kill_mud_weight_ppg"] == 10.37
    assert result["banner"].startswith("DECISION SUPPORT ONLY")
    assert turn.flags == []
    assert turn.audit["n_tool_calls"] == 1


def test_orchestrator_returns_explicit_tool_input_error():
    orch = Orchestrator(llm=SequenceLLM([kill_sheet_tool_call("[1,2]")]))

    turn = asyncio.run(orch.handle("Build a kill sheet", module="well_control", tenant_id="tenant-a"))

    assert "deterministic tool call" in turn.answer
    assert "tool_input_error" in turn.flags
    assert turn.audit["stopped_at"] == "tool_input"
