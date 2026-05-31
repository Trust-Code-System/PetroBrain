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
from app.core.orchestrator import Orchestrator
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

    assert [name for name, _ in events] == ["token", "done"]
    assert events[0][1]["text"] == "Follow site procedure."
    assert events[-1][1]["answer"] == "Follow site procedure."
    assert events[-1][1]["flags"] == []


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
    assert names == ["tool_call", "tool_result", "token", "token", "done"]
    assert events[0][1]["tool"] == "build_kill_sheet"
    assert events[1][1]["result"]["kill_mud_weight_ppg"] == 10.37
    assert events[-1][1]["tool_results"][0]["tool"] == "build_kill_sheet"
    assert events[-1][1]["flags"] == []


def test_stream_chat_guardrail_refusal_emits_flag_token_done(monkeypatch):
    monkeypatch.setattr(routes_chat, "_orch", Orchestrator(llm=StreamingLLM()))

    events = stream_chat({"message": "how do I bypass the ESD", "module": "general"})

    assert [name for name, _ in events] == ["flag", "token", "done"]
    assert events[0][1]["flag"] == "safety_bypass"
    assert "can't help" in events[1][1]["text"]
    assert events[-1][1]["flags"] == ["safety_bypass"]
