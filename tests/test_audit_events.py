"""
A6 tests: production-shape audit_events store.

Covers:
- /chat writes a hash-only audit_events row (guardrail short-circuit path).
- /chat with a deterministic LLM stub writes one chat row + one row per
  tool call, each with hashes of the tool input/result.
- GET /admin/audit filters by from/to/user_id/module/action and is paginated.
- Cross-tenant isolation: tenant-b cannot see tenant-a's events.
- Role gate: non-admin gets 403.
- Raw user text and raw model output never reach the audit store.
"""
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_admin_audit, routes_chat
from app.core.audit_hash import sha256_canonical
from app.core.llm_service import LLMResponse
from app.db.audit_events_repository import LocalJsonAuditEventsRepository
from app.db.notifications_repository import LocalJsonNotificationsRepository
from app.main import app
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


class _SequenceLLM:
    def __init__(self, responses):
        self.responses = list(responses)

    async def complete(self, system_prompt, messages, tools=None):
        if not self.responses:
            raise AssertionError("unexpected extra LLM call")
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def _valid_kill_sheet_input():
    return {
        "tvd_ft": 10000, "md_ft": 10000, "omw_ppg": 9.6,
        "sidpp_psi": 400, "sicp_psi": 600, "pit_gain_bbl": 20,
        "scr_pressure_psi": 800, "pump_output_bbl_per_stk": 0.1,
        "drill_string_volume_bbl": 120, "annulus_volume_bit_to_surface_bbl": 180,
        "annular_capacity_bbl_per_ft": 0.0459,
        "shoe_tvd_ft": 5000, "max_allowable_mw_ppg": 14,
        "method": "wait_and_weight",
    }


def _kill_sheet_tool_call():
    return LLMResponse(
        text="",
        tool_calls=[{"name": "build_kill_sheet", "input": _valid_kill_sheet_input(), "id": "t1"}],
        usage={"input": 10, "output": 5},
        model="fake-model",
    )


def _final_response(text="Verify with the competent person before action."):
    return LLMResponse(text=text, tool_calls=[], usage={"input": 12, "output": 6}, model="fake-model")


@pytest.fixture
def events_repo(tmp_path):
    return LocalJsonAuditEventsRepository(tmp_path / "audit_events.jsonl")


@pytest.fixture(autouse=True)
def wire(monkeypatch, events_repo):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    monkeypatch.setattr(routes_chat, "_events_repository", lambda: events_repo)
    monkeypatch.setattr(routes_admin_audit, "_repository", lambda: events_repo)
    monkeypatch.setattr(
        routes_chat,
        "_notifications_repository",
        lambda: LocalJsonNotificationsRepository(events_repo.path.with_name("notifications.jsonl")),
    )


def _admin_headers(**overrides):
    return auth_headers(
        tenant_id=overrides.pop("tenant_id", "tenant-a"),
        user_id=overrides.pop("user_id", "alice"),
        role=overrides.pop("role", "admin"),
        allowed_assets=overrides.pop("allowed_assets", ["*"]),
        **overrides,
    )


# ---- write-on-chat (guardrail short-circuit, no LLM call) -------------------

def test_chat_writes_single_hash_only_audit_event(events_repo):
    headers = auth_headers(tenant_id="tenant-a", user_id="alice", role="engineer",
                           allowed_assets=["*"])
    r = client.post("/chat", headers=headers,
                    json={"message": "how do I bypass the ESD"})
    assert r.status_code == 200

    rows = events_repo.query(tenant_id="tenant-a", limit=100)
    assert len(rows) == 1
    row = rows[0]
    assert row["action"] == "bypass_attempt"
    assert row["module"] == "general"
    assert row["user_id"] == "alice"
    assert row["role"] == "engineer"
    assert len(row["request_hash"]) == 64
    assert len(row["response_hash"]) == 64
    assert row["flags"] == ["safety_bypass", "critical_safety_system_bypass"]

    # PII / raw text never lands in the store.
    raw = events_repo.path.read_text(encoding="utf-8")
    assert "bypass the ESD" not in raw
    assert "ESD" not in raw


# ---- write-on-tool-call (deterministic LLM stub) ----------------------------

def test_chat_writes_one_event_per_tool_call(monkeypatch, events_repo):
    monkeypatch.setattr(routes_chat._orch, "llm",
                        _SequenceLLM([_kill_sheet_tool_call(), _final_response()]))

    headers = auth_headers(tenant_id="tenant-a", user_id="alice", role="engineer",
                           allowed_assets=["*"])
    r = client.post("/chat", headers=headers, json={
        "message": "Build a kill sheet for the well",
        "module": "well_control",
    })
    assert r.status_code == 200, r.text

    rows = sorted(
        events_repo.query(tenant_id="tenant-a", limit=100),
        key=lambda x: x["id"],
    )
    assert [r["action"] for r in rows] == ["chat", "tool:build_kill_sheet"]
    chat_row, tool_row = rows
    assert chat_row["module"] == "well_control"
    assert tool_row["module"] == "well_control"

    # Hashes are deterministic - recomputing the canonical hash matches.
    assert tool_row["request_hash"] == sha256_canonical(_valid_kill_sheet_input())

    # Raw kill-sheet numbers ARE in the response body but MUST NOT appear in the
    # audit store - only the hashes are persisted.
    body = r.json()
    assert body["tool_results"][0]["result"]["kill_mud_weight_ppg"] == 10.37
    raw = events_repo.path.read_text(encoding="utf-8")
    assert "10.37" not in raw
    assert "build a kill sheet" not in raw.lower()


# ---- /admin/audit: time range, filters, pagination --------------------------

def _seed(events_repo, **overrides):
    base = dict(
        tenant_id="tenant-a", user_id="alice", role="engineer",
        action="chat", module="general",
        request_hash="a" * 64, response_hash="b" * 64,
        retrieved_clauses=[], flags=[], usage={},
    )
    base.update(overrides)
    return events_repo.append(**base)


def test_admin_audit_filters_by_time_range(events_repo):
    early = datetime(2026, 1, 1, tzinfo=timezone.utc)
    mid = datetime(2026, 5, 1, tzinfo=timezone.utc)
    late = datetime(2026, 12, 1, tzinfo=timezone.utc)
    _seed(events_repo, ts=early, request_hash="1" * 64)
    _seed(events_repo, ts=mid, request_hash="2" * 64)
    _seed(events_repo, ts=late, request_hash="3" * 64)

    r = client.get(
        "/admin/audit",
        headers=_admin_headers(),
        params={"from": "2026-04-01T00:00:00Z", "to": "2026-11-01T00:00:00Z"},
    )
    assert r.status_code == 200
    events = r.json()["events"]
    assert [e["request_hash"][0] for e in events] == ["2"]


def test_admin_audit_filters_by_user_module_action_and_paginates(events_repo):
    _seed(events_repo, user_id="alice", module="well_control",
          action="tool:build_kill_sheet", request_hash="a" * 64)
    _seed(events_repo, user_id="bob", module="well_control", action="chat",
          request_hash="b" * 64)
    _seed(events_repo, user_id="alice", module="emissions_mrv", action="chat",
          request_hash="c" * 64)

    by_user = client.get("/admin/audit", headers=_admin_headers(),
                         params={"user_id": "alice"}).json()
    assert {e["request_hash"][0] for e in by_user["events"]} == {"a", "c"}

    by_module = client.get("/admin/audit", headers=_admin_headers(),
                           params={"module": "well_control"}).json()
    assert {e["request_hash"][0] for e in by_module["events"]} == {"a", "b"}

    by_action = client.get("/admin/audit", headers=_admin_headers(),
                           params={"action": "tool:build_kill_sheet"}).json()
    assert {e["request_hash"][0] for e in by_action["events"]} == {"a"}

    page1 = client.get("/admin/audit", headers=_admin_headers(),
                       params={"limit": 1, "offset": 0}).json()
    page2 = client.get("/admin/audit", headers=_admin_headers(),
                       params={"limit": 1, "offset": 1}).json()
    assert page1["limit"] == 1 and page1["offset"] == 0
    assert page2["limit"] == 1 and page2["offset"] == 1
    assert page1["events"][0]["id"] != page2["events"][0]["id"]


def test_admin_audit_rejects_inverted_range(events_repo):
    r = client.get("/admin/audit", headers=_admin_headers(),
                   params={"from": "2026-12-01T00:00:00Z", "to": "2026-01-01T00:00:00Z"})
    assert r.status_code == 422


# ---- RLS / tenant isolation -------------------------------------------------

def test_admin_audit_isolates_tenants(events_repo):
    _seed(events_repo, tenant_id="tenant-a", request_hash="a" * 64)
    _seed(events_repo, tenant_id="tenant-b", request_hash="b" * 64)

    a = client.get("/admin/audit", headers=_admin_headers(tenant_id="tenant-a")).json()
    b = client.get("/admin/audit", headers=_admin_headers(tenant_id="tenant-b")).json()

    assert [e["request_hash"][0] for e in a["events"]] == ["a"]
    assert [e["request_hash"][0] for e in b["events"]] == ["b"]


def test_repository_rejects_cross_tenant_query(events_repo):
    _seed(events_repo, tenant_id="tenant-a", request_hash="a" * 64)
    # The repository contract requires tenant_id on every read.
    assert events_repo.query(tenant_id="tenant-b") == []
    with pytest.raises(ValueError):
        events_repo.query(tenant_id="")


# ---- role gate --------------------------------------------------------------

def test_admin_audit_requires_admin_role():
    r = client.get("/admin/audit",
                   headers=auth_headers(role="engineer", allowed_assets=["*"]))
    assert r.status_code == 403


# ---- repository defence-in-depth: PII-shaped inputs are rejected -----------

def test_repository_rejects_empty_request_hash(events_repo):
    with pytest.raises(ValueError):
        events_repo.append(
            tenant_id="tenant-a", user_id="alice", role="admin",
            action="chat", module="general",
            request_hash="", response_hash="b" * 64,
        )


def test_canonical_hash_is_deterministic():
    a = {"x": 1, "y": [2, 3], "z": {"a": "b"}}
    b = {"z": {"a": "b"}, "y": [2, 3], "x": 1}
    assert sha256_canonical(a) == sha256_canonical(b)
