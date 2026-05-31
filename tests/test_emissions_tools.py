"""Emissions MRV deterministic tool wrapper tests."""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.llm_service import LLMResponse
from app.core.orchestrator import MODULE_TOOLS, Orchestrator, TOOL_REGISTRY
from app.modules.emissions_mrv.agent import (
    BUILD_GHGEMP_REPORT_TOOL,
    COMBUSTION_TOOL,
    FLARING_TOOL,
    FUGITIVE_TIER2_TOOL,
    FUGITIVE_TIER3_TOOL,
    VENTING_TOOL,
    run_build_ghgemp_report_tool,
    run_combustion_tool,
    run_flaring_tool,
    run_fugitive_tier2_tool,
    run_fugitive_tier3_tool,
    run_venting_tool,
)


class SequenceLLM:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def complete(self, system_prompt, messages, tools=None):
        self.calls.append({"system": system_prompt, "messages": messages, "tools": tools})
        if not self.responses:
            raise AssertionError("unexpected extra LLM call")
        return self.responses.pop(0)


def test_emissions_line_tool_entrypoints_return_auditable_lines():
    flaring = run_flaring_tool({
        "source_id": "FL-1",
        "gas_volume_scf": 1_000_000,
        "composition": {"CH4": 1.0},
        "combustion_efficiency": 0.98,
        "measured": True,
    })
    venting = run_venting_tool({
        "source_id": "V-1",
        "gas_volume_scf": 100_000,
        "composition": {"CH4": 0.92, "CO2": 0.04, "N2": 0.04},
        "measured": True,
    })
    fugitive_t2 = run_fugitive_tier2_tool({
        "source_id": "AREA-1",
        "component_counts": {"valve": 100, "flange": 200},
        "operating_hours": 8760,
    })
    fugitive_t3 = run_fugitive_tier3_tool({
        "source_id": "AREA-2",
        "measured_leaks_kg_ch4_per_hr": [0.5, 0.3, 0.2],
        "operating_hours": 8760,
    })
    combustion = run_combustion_tool({
        "source_id": "GT-1",
        "fuel_scf": 500_000,
        "co2_kg_per_scf": 0.0545,
        "ch4_kg_per_scf": 0.000001,
        "n2o_kg_per_scf": 0.0000001,
    })

    assert flaring["source_id"] == "FL-1"
    assert flaring["tier"] == "Tier 3"
    assert flaring["co2_tonnes"] > 0
    assert venting["source_type"] == "venting"
    assert venting["ch4_tonnes"] > 0
    assert fugitive_t2["tier"] == "Tier 2"
    assert fugitive_t3["tier"] == "Tier 3"
    assert combustion["source_type"] == "combustion"
    for line in (flaring, venting, fugitive_t2, fugitive_t3, combustion):
        assert line["method"]
        assert "activity" in line


def test_build_ghgemp_report_tool_uses_precomputed_line_items():
    line = run_flaring_tool({
        "source_id": "FL-1",
        "gas_volume_scf": 1_000_000,
        "composition": {"CH4": 1.0},
        "combustion_efficiency": 0.98,
        "measured": True,
    })

    result = run_build_ghgemp_report_tool({
        "facility_id": "FAC-1",
        "period": "2026-Q3",
        "operator": "Demo E&P",
        "asset": "OML-DEMO",
        "gwp_set": "AR6",
        "target_tier": "Tier 3",
        "lines": [line],
    })

    assert result["inventory"]["facility_id"] == "FAC-1"
    assert result["inventory"]["totals"]["co2e_tonnes"] > 0
    assert result["ghgemp_report"]["audit_sha256"]
    assert result["mrv_readiness"]["status"] == "ready_for_target_tier"
    assert "LLM must not recompute" in result["notes"][0]


def test_emissions_tools_registered_for_module():
    expected = {
        "flaring_emissions",
        "venting_emissions",
        "fugitive_tier2",
        "fugitive_tier3",
        "combustion_emissions",
        "build_ghgemp_report",
        "web_search",
    }

    assert set(MODULE_TOOLS["emissions_mrv"]) == expected
    assert TOOL_REGISTRY["flaring_emissions"][0] is FLARING_TOOL
    assert TOOL_REGISTRY["venting_emissions"][0] is VENTING_TOOL
    assert TOOL_REGISTRY["fugitive_tier2"][0] is FUGITIVE_TIER2_TOOL
    assert TOOL_REGISTRY["fugitive_tier3"][0] is FUGITIVE_TIER3_TOOL
    assert TOOL_REGISTRY["combustion_emissions"][0] is COMBUSTION_TOOL
    assert TOOL_REGISTRY["build_ghgemp_report"][0] is BUILD_GHGEMP_REPORT_TOOL


def test_orchestrator_dispatches_emissions_tool_without_llm_arithmetic():
    first = LLMResponse(
        text="",
        tool_calls=[{
            "name": "flaring_emissions",
            "id": "tool-1",
            "input": {
                "source_id": "FL-1",
                "gas_volume_scf": 1_000_000,
                "composition": {"CH4": 1.0},
                "combustion_efficiency": 0.98,
                "measured": True,
            },
        }],
        usage={"input": 10, "output": 5},
        model="fake-model",
    )
    final = LLMResponse(
        text="Use the tool result and verify factors/GWP against current NUPRC guidance.",
        tool_calls=[],
        usage={"input": 12, "output": 6},
        model="fake-model",
    )
    llm = SequenceLLM([first, final])
    orch = Orchestrator(llm=llm)

    turn = asyncio.run(orch.handle("Estimate flare emissions", module="emissions_mrv", tenant_id="tenant-a"))

    assert llm.calls[0]["tools"]
    assert {tool["name"] for tool in llm.calls[0]["tools"]} == set(MODULE_TOOLS["emissions_mrv"])
    assert turn.tool_results[0]["tool"] == "flaring_emissions"
    assert turn.tool_results[0]["result"]["co2_tonnes"] > 0
    assert turn.flags == []
