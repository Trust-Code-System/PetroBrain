"""SSE streaming tests for /chat?stream=true."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_chat
from app.core.audit import AuditLogger
from app.core.llm_service import LLMResponse
from app.core.orchestrator import Orchestrator, TOOL_REGISTRY
from app.db.audit_events_repository import LocalJsonAuditEventsRepository
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


class StreamingLLM:
    def __init__(self, stream_tokens=None, complete_responses=None):
        self.stream_tokens = list(stream_tokens or [])
        self.complete_responses = list(complete_responses or [])
        self.complete_calls = []
        self.stream_calls = []

    async def complete(self, system_prompt, messages, tools=None):
        self.complete_calls.append({"system": system_prompt, "messages": messages, "tools": tools})
        if not self.complete_responses:
            raise AssertionError("unexpected complete() call")
        return self.complete_responses.pop(0)

    async def stream_complete(self, system_prompt, messages, tools=None):
        self.stream_calls.append({"system": system_prompt, "messages": messages, "tools": tools})
        text = ""
        for token in self.stream_tokens:
            text += token
            yield {"type": "token", "text": token}
        yield {
            "type": "done",
            "text": text,
            "tool_calls": [],
            "usage": {"input": 5, "output": len(self.stream_tokens)},
            "model": "fake-stream-model",
        }


@pytest.fixture(autouse=True)
def wire(monkeypatch, tmp_path):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    monkeypatch.setattr(routes_chat, "audit_logger", AuditLogger(tmp_path / "audit.jsonl"))
    monkeypatch.setattr(
        routes_chat,
        "_events_repository",
        lambda: LocalJsonAuditEventsRepository(tmp_path / "audit_events.jsonl"),
    )


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


def parse_sse(raw: str) -> list[tuple[str, dict]]:
    events = []
    for block in raw.strip().split("\n\n"):
        lines = block.splitlines()
        event = next(line.removeprefix("event:").strip() for line in lines if line.startswith("event:"))
        data = next(line.removeprefix("data:").strip() for line in lines if line.startswith("data:"))
        events.append((event, json.loads(data)))
    return events


def stream_chat(payload):
    with client.stream(
        "POST",
        "/chat?stream=true",
        headers=auth_headers(tenant_id="tenant-stream", role="engineer", allowed_assets=["*"]),
        json=payload,
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        return parse_sse("".join(response.iter_text()))


def event_names(events):
    return [name for name, _ in events]


def event_data(events, name):
    return [data for event, data in events if event == name]


def assert_typed_envelope(events):
    for name, data in events:
        assert data["type"] == name
        assert data["step_id"]
        assert data["status"] in {"pending", "running", "completed", "failed"}
        assert data["message"]
        assert data["timestamp"]


def test_chat_route_overrides_general_with_research_intent(monkeypatch):
    observed = {}

    class RoutingOrchestrator:
        async def stream_handle(self, message, **kwargs):
            observed["message"] = message
            observed["module"] = kwargs["module"]
            yield {
                "event": "done",
                "data": {
                    "answer": "Research answer.",
                    "tool_results": [],
                    "flags": [],
                    "audit": {"module": kwargs["module"]},
                    "evidence_pack": {},
                },
            }

    monkeypatch.setattr(routes_chat, "_orch", RoutingOrchestrator())

    events = stream_chat(
        {
            "message": "Run a deep research report on Nigeria upstream licensing.",
            "module": "general",
        }
    )

    assert observed["module"] == "research"
    assert events[-1][1]["audit"]["module"] == "research"


def test_chat_route_switches_unpinned_specialist_and_streams_routing_metadata(monkeypatch):
    observed = {}

    class RoutingOrchestrator:
        async def stream_handle(self, message, **kwargs):
            observed["module"] = kwargs["module"]
            yield {
                "event": "done",
                "data": {
                    "answer": "Calculated.",
                    "tool_results": [],
                    "flags": [],
                    "audit": {"module": kwargs["module"]},
                    "evidence_pack": {},
                },
            }

    monkeypatch.setattr(routes_chat, "_orch", RoutingOrchestrator())

    events = stream_chat({
        "message": "Calculate flaring emissions for this source.",
        "module": "research",
        "requested_module": "research",
        "auto_route_enabled": True,
        "module_pinned": False,
    })

    assert observed["module"] == "emissions_mrv"
    assert events[0][0] == "routing"
    assert events[0][1]["resolved_module"] == "emissions_mrv"
    assert events[0][1]["requested_module"] == "research"
    assert events[0][1]["user_visible_notice"] == (
        "Switched to Emissions / MRV for this turn."
    )
    assert events[-1][1]["resolved_module"] == "emissions_mrv"


def test_chat_route_respects_pinned_module_and_streams_conflict_warning(monkeypatch):
    observed = {}

    class RoutingOrchestrator:
        async def stream_handle(self, message, **kwargs):
            observed["module"] = kwargs["module"]
            yield {
                "event": "done",
                "data": {
                    "answer": "Pinned response.",
                    "tool_results": [],
                    "flags": [],
                    "audit": {"module": kwargs["module"]},
                    "evidence_pack": {},
                },
            }

    monkeypatch.setattr(routes_chat, "_orch", RoutingOrchestrator())

    events = stream_chat({
        "message": "Calculate flaring emissions for this source.",
        "module": "research",
        "requested_module": "research",
        "module_pinned": True,
    })

    assert observed["module"] == "research"
    assert events[0][1]["detected_module"] == "emissions_mrv"
    assert events[0][1]["user_visible_notice"] == (
        "This question appears to match Emissions / MRV, but Research is pinned."
    )


def test_non_streaming_chat_returns_resolved_module_metadata(monkeypatch):
    observed = {}

    class RoutingOrchestrator:
        async def handle(self, message, **kwargs):
            observed["module"] = kwargs["module"]
            from app.core.orchestrator import Turn
            return Turn(answer="Research answer.")

    monkeypatch.setattr(routes_chat, "_orch", RoutingOrchestrator())

    response = client.post(
        "/chat",
        headers=auth_headers(
            tenant_id="tenant-stream", role="engineer", allowed_assets=["*"]
        ),
        json={
            "message": "Run a deep research report on Nigerian licensing.",
            "module": "emissions_mrv",
            "requested_module": "emissions_mrv",
            "auto_route_enabled": True,
            "module_pinned": False,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert observed["module"] == "research"
    assert body["requested_module"] == "emissions_mrv"
    assert body["resolved_module"] == "research"
    assert body["routing_confidence"] == "high"
    assert body["user_visible_notice"] == "Switched to Research for this turn."


def test_stream_chat_emits_tokens_then_done(monkeypatch):
    # The "general" module now exposes the web_search tool, so the orchestrator
    # makes a non-streaming complete() call first to detect any tool_use. When
    # the model returns plain text (no tool calls) the orchestrator falls back
    # to a single token event with the full answer.
    no_tool_response = LLMResponse(
        text="Follow site procedure.",
        tool_calls=[],
        usage={"input": 8, "output": 5},
        model="fake-model",
    )
    llm = StreamingLLM(complete_responses=[no_tool_response])
    monkeypatch.setattr(routes_chat, "_orch", Orchestrator(llm=llm))

    events = stream_chat({"message": "Explain flare MRV checks", "module": "general"})

    names = event_names(events)
    assert names.index("status") < names.index("token")
    assert names[-2:] == ["final", "done"]
    assert event_data(events, "token")[0]["text"] == "Follow site procedure."
    assert events[-1][1]["answer"] == "Follow site procedure."
    assert events[-1][1]["flags"] == []
    assert_typed_envelope(events)


def test_stream_chat_emits_tool_call_tool_result_tokens_done(monkeypatch):
    first = LLMResponse(
        text="",
        tool_calls=[{"name": "build_kill_sheet", "input": valid_kill_sheet_input(), "id": "tool-1"}],
        usage={"input": 10, "output": 5},
        model="fake-model",
    )
    llm = StreamingLLM(
        stream_tokens=["Verify ", "with the competent person before action."],
        complete_responses=[first],
    )
    monkeypatch.setattr(routes_chat, "_orch", Orchestrator(llm=llm))

    events = stream_chat({
        "message": "Build a kill sheet for the well",
        "module": "well_control",
    })

    names = [name for name, _ in events]
    assert names.index("tool_call_started") < names.index("tool_call")
    assert names.index("tool_call") < names.index("tool_result")
    assert names.index("tool_result") < names.index("tool_call_completed")
    assert names[-2:] == ["final", "done"]
    assert event_data(events, "tool_call")[0]["tool"] == "build_kill_sheet"
    assert event_data(events, "tool_result")[0]["result"]["kill_mud_weight_ppg"] == 10.37
    assert events[-1][1]["tool_results"][0]["tool"] == "build_kill_sheet"
    assert events[-1][1]["flags"] == []
    assert any(
        data["message"] == "Running deterministic kill sheet calculations..."
        for data in event_data(events, "tool_call_started")
    )


def test_stream_chat_synthesizes_web_results_into_structured_answer(monkeypatch):
    schema, _ = TOOL_REGISTRY["web_search"]
    monkeypatch.setitem(
        TOOL_REGISTRY,
        "web_search",
        (
            schema,
            lambda payload: {
                "query": payload["query"],
                "provider": "test",
                "results": [
                    {
                        "title": "# Metropole **Petroleum** Limited",
                        "url": "https://example.com/metropole",
                        "snippet": "### **Metropole Petroleum Limited** is listed as an oil and gas company with public corporate references.",
                    }
                ],
            },
        ),
    )
    first = LLMResponse(
        text="",
        tool_calls=[{
            "name": "web_search",
            "input": {"query": "Metropole Petroleum"},
            "id": "tool-web-1",
        }],
        usage={"input": 10, "output": 5},
        model="fake-model",
    )
    llm = StreamingLLM(
        stream_tokens=[
            "# Metropole Petroleum Overview\n\n",
            "## Executive summary\nMetropole appears in public oil and gas records [S1].\n\n",
            "## What I checked\n- Public corporate source.\n\n",
            "## What I could not verify\n- Current ownership.\n\n",
            "## Confidence\nMedium.\n\n",
            "## Sources / citations\n- [S1] Metropole Petroleum Limited",
        ],
        complete_responses=[first],
    )
    monkeypatch.setattr(routes_chat, "_orch", Orchestrator(llm=llm))

    events = stream_chat({
        "message": "what do you know about metropole petroleum",
        "module": "general",
    })

    names = [name for name, _ in events]
    assert names.index("source_search_started") < names.index("source_found")
    assert names.index("source_found") < names.index("citation_check_started")
    assert names.index("citation_check_completed") < names.index("citation")
    assert names[-1] == "done"
    answer = "".join(data["text"] for name, data in events if name == "token")
    assert "# Metropole Petroleum Overview" in answer
    assert "## Executive summary" in answer
    assert "I found current public sources" not in answer
    assert "Based on the returned snippets" not in answer
    assert events[-1][1]["answer"] == answer


def test_stream_chat_dedupes_repeated_web_sources(monkeypatch):
    schema, _ = TOOL_REGISTRY["web_search"]
    duplicate_title = "From the Right: Kola Kelani (CFO, Bono Energy Limited), Adejare..."
    duplicate_snippet = (
        "From the Right: Kola Kelani (CFO, Bono Energy Limited), Adejare Kikelomo "
        "(Regulatory Officer/Director), Steve Okeleji (MD/CEO)."
    )
    monkeypatch.setitem(
        TOOL_REGISTRY,
        "web_search",
        (
            schema,
            lambda payload: {
                "query": payload["query"],
                "provider": "test",
                "results": [
                    {
                        "title": duplicate_title,
                        "url": "https://example.com/a",
                        "snippet": duplicate_snippet,
                    },
                    {
                        "title": duplicate_title,
                        "url": "https://example.com/b",
                        "snippet": duplicate_snippet,
                    },
                    {
                        "title": "Bono Energy: Employee Directory",
                        "url": "https://example.com/directory",
                        "snippet": "Some Bono Energy key employees are listed in public business directories.",
                    },
                ],
            },
        ),
    )
    first = LLMResponse(
        text="",
        tool_calls=[{
            "name": "web_search",
            "input": {"query": "Bono Energy"},
            "id": "tool-web-1",
        }],
        usage={"input": 10, "output": 5},
        model="fake-model",
    )
    llm = StreamingLLM(
        stream_tokens=[
            "# Bono Energy Overview\n\n## Executive summary\n",
            "Public records identify relevant company information [S1] [S2].",
        ],
        complete_responses=[first],
    )
    monkeypatch.setattr(routes_chat, "_orch", Orchestrator(llm=llm))

    events = stream_chat({
        "message": "what do you know about bono energy",
        "module": "general",
    })

    citations = [data for name, data in events if name == "citation"]
    assert len(citations) == 2
    assert sum("From the Right" in citation["title"] for citation in citations) == 1
    assert any("Employee Directory" in citation["title"] for citation in citations)


def test_stream_chat_guardrail_refusal_emits_flag_token_done(monkeypatch):
    monkeypatch.setattr(routes_chat, "_orch", Orchestrator(llm=StreamingLLM()))

    events = stream_chat({"message": "how do I bypass the ESD", "module": "general"})

    names = event_names(events)
    assert names.index("safety_check_started") < names.index("flag")
    assert names[-2:] == ["final", "done"]
    assert event_data(events, "flag")[0]["flag"] == "safety_bypass"
    assert "can't help" in event_data(events, "token")[0]["text"]
    assert events[-1][1]["flags"] == ["safety_bypass"]


def test_research_mode_emits_research_plan_and_source_lifecycle(monkeypatch):
    schema, _ = TOOL_REGISTRY["web_search"]
    monkeypatch.setitem(
        TOOL_REGISTRY,
        "web_search",
        (
            schema,
            lambda payload: {
                "query": payload["query"],
                "provider": "test",
                "results": [{
                    "title": "NUPRC upstream overview",
                    "url": "https://nuprc.gov.ng/upstream",
                    "snippet": "Nigeria upstream petroleum regulation and licensing.",
                }],
            },
        ),
    )
    first = LLMResponse(
        text="",
        tool_calls=[{
            "name": "web_search",
            "input": {"query": "Nigeria upstream sector"},
            "id": "research-search",
        }],
        usage={},
        model="fake-model",
    )
    llm = StreamingLLM(
        complete_responses=[first],
        stream_tokens=["# Nigeria upstream overview\n\nNUPRC regulates upstream activity [S1]."],
    )
    monkeypatch.setattr(routes_chat, "_orch", Orchestrator(llm=llm))

    events = stream_chat({
        "message": "Give me a full overview of Nigeria upstream and cite sources.",
        "module": "research",
    })

    names = event_names(events)
    assert "research_plan" in names
    assert "source_search_started" in names
    assert "source_found" in names
    assert "evidence_pack_started" in names
    assert "citation_check_completed" in names
    assert "synthesis_started" in names
    assert names.index("research_plan") < names.index("token")
    assert_typed_envelope(events)
    raw = json.dumps(events).lower()
    assert "chain-of-thought" not in raw
    assert "reasoning internally" not in raw
    assert "system prompt" not in raw


def test_ptw_mode_emits_tool_and_safety_progress(monkeypatch):
    first = LLMResponse(
        text="",
        tool_calls=[{
            "name": "build_ptw_template",
            "input": {
                "work_type": "hot_work",
                "job_description": "Hot work on production facility",
                "location": "process area",
            },
            "id": "ptw-tool",
        }],
        usage={},
        model="fake-model",
    )
    llm = StreamingLLM(
        complete_responses=[first],
        stream_tokens=["# Hot work permit draft\n\nVerify and authorize before work."],
    )
    monkeypatch.setattr(routes_chat, "_orch", Orchestrator(llm=llm))

    events = stream_chat({
        "message": "Create a Permit to Work draft for hot work on a crude oil production facility.",
        "module": "ptw",
    })

    messages = [data["message"] for _, data in events]
    assert "Building hazards, controls, and sign-off blocks..." in messages
    assert "Checking final safety and compliance constraints..." in messages
    assert event_names(events)[-2:] == ["final", "done"]


def test_stream_errors_emit_safe_error_event(monkeypatch):
    class BrokenOrchestrator:
        async def stream_handle(self, *args, **kwargs):
            raise RuntimeError("private provider failure detail")
            yield  # pragma: no cover

    monkeypatch.setattr(routes_chat, "_orch", BrokenOrchestrator())

    events = stream_chat({"message": "Research Nigeria upstream", "module": "research"})

    assert event_names(events) == ["routing", "error", "done"]
    assert events[1][1]["status"] == "failed"
    assert "private provider failure detail" not in json.dumps(events)
