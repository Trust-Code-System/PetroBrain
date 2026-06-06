"""Research Mode lifecycle, grounding, isolation, and audit tests."""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.api import deps, routes_research
from app.core.audit import AuditLogger
from app.core.llm_service import LLMResponse
from app.db.research_repository import LocalJsonResearchRepository
from app.main import app
from app.research.service import ResearchService
from tests.auth_helpers import auth_headers, jwt_settings


client = TestClient(app)


class FakeDocuments:
    def snapshot(self, *, tenant_id: str, since=None):
        if tenant_id != "tenant-a":
            return []
        return [
            {
                "tenant_id": tenant_id,
                "document_id": "NUPRC-GUIDE",
                "title": "NUPRC Methane Guidance",
                "revision": "2025",
                "effective_date": "2025-01-01",
                "asset": "asset-a",
                "chunks": [
                    {
                        "clause": "4.2",
                        "text": (
                            "Methane measurement plans should identify sources, "
                            "measurement methods, assurance controls, and reporting gaps."
                        ),
                    }
                ],
            }
        ]


class FakeLLM:
    def __init__(self, text: str | None = None):
        self.text = text or (
            "# Methane readiness\n\n"
            "## Executive summary\n\n"
            "The available guidance emphasizes measurement plans and assurance [S1].\n\n"
            "## Key findings\n\n"
            "- Source inventories and assurance controls are required [S1].\n\n"
            "## Evidence and analysis\n\n"
            "The internal guidance identifies measurement methods and reporting gaps [S1].\n\n"
            "## Contradictions and source limitations\n\n"
            "- No contradiction was identified in the collected evidence.\n\n"
            "## Assumptions\n\n"
            "- The uploaded guidance is the current controlled revision.\n\n"
            "## What I checked\n\n"
            "- Tenant guidance [S1].\n\n"
            "## What I could not verify\n\n"
            "- Public regulator updates were not available.\n\n"
            "## Recommended next actions\n\n"
            "- Confirm the controlled document revision with compliance.\n\n"
            "## Safety and compliance notice\n\n"
            "- Decision support only."
        )

    async def complete(self, system, messages, tools=None, thinking_mode="default"):
        return LLMResponse(
            text=self.text,
            tool_calls=[],
            usage={"input": 10, "output": 20},
            model="fake-research-model",
        )


def test_model_unavailable_fallback_does_not_dump_source_snippets(tmp_path):
    service = ResearchService(
        repository=LocalJsonResearchRepository(tmp_path / "research.jsonl"),
        llm=FakeLLM(),
        document_repository=FakeDocuments(),
    )
    markdown = service._source_digest_report(
        "Assess methane readiness",
        [
            {
                "id": "S1",
                "title": "NUPRC Methane Guidance",
                "snippet": "RAW GOVERNED EXCERPT THAT MUST NOT BE THE ANSWER",
                "reliability": "primary",
                "freshness": "current",
            }
        ],
        ["Current implementation status was not verified."],
        ["Decision support only."],
    )

    assert "RAW GOVERNED EXCERPT" not in markdown
    assert "Raw source excerpts are not shown" in markdown


@pytest.fixture(autouse=True)
def wire(monkeypatch, tmp_path):
    monkeypatch.setattr(deps, "get_settings", jwt_settings)
    repository = LocalJsonResearchRepository(tmp_path / "research.jsonl")
    service = ResearchService(
        repository=repository,
        llm=FakeLLM(),
        document_repository=FakeDocuments(),
    )
    monkeypatch.setattr(routes_research, "research_service", service)
    monkeypatch.setattr(
        routes_research,
        "audit_logger",
        AuditLogger(tmp_path / "audit.jsonl"),
    )
    monkeypatch.setattr(
        "app.research.service.run_web_search_tool",
        lambda payload: {
            "disabled": True,
            "reason": "not configured",
            "query": payload["query"],
            "results": [],
        },
    )
    return {
        "repository": repository,
        "service": service,
        "audit_path": tmp_path / "audit.jsonl",
    }


def plan_payload(**overrides):
    payload = {
        "query": "Assess methane measurement readiness for the asset",
        "jurisdiction": "Nigeria",
        "asset_context": "asset-a",
        "internal_documents_allowed": True,
        "web_search_allowed": True,
        "connectors_allowed": False,
        "maximum_research_steps": 3,
        "maximum_sources": 8,
        "report_type": "technical_research_brief",
        "output_depth": "standard",
        "citation_required": True,
        "safety_critical": False,
        "export_format": "markdown",
    }
    payload.update(overrides)
    return payload


def create_plan(headers=None, **overrides):
    response = client.post(
        "/research/plan",
        headers=headers or auth_headers(
            tenant_id="tenant-a",
            role="engineer",
            allowed_assets=["asset-a"],
        ),
        json=plan_payload(**overrides),
    )
    assert response.status_code == 201, response.text
    return response.json()


def approve(research_id: str, headers=None):
    response = client.post(
        f"/research/{research_id}/approve-plan",
        headers=headers or auth_headers(
            tenant_id="tenant-a",
            role="engineer",
            allowed_assets=["asset-a"],
        ),
        json={"action": "approve"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_plan_approve_run_and_export_creates_grounded_report(wire):
    headers = auth_headers(
        tenant_id="tenant-a", role="engineer", allowed_assets=["asset-a"]
    )
    planned = create_plan(headers)
    assert planned["status"] == "plan_ready"
    assert len(planned["plan"]) == 3

    approved = approve(planned["id"], headers)
    assert approved["status"] == "approved"

    response = client.post(
        "/research/run",
        headers=headers,
        json={"research_id": planned["id"]},
    )
    assert response.status_code == 200, response.text
    completed = response.json()
    assert completed["status"] == "completed"
    assert completed["sources"][0]["source_type"] == "internal_document"
    assert completed["sources"][0]["reliability"] == "primary"
    assert "[S1]" in completed["report"]["markdown"]
    assert completed["evidence_pack"]["sources"]
    assert "web_search_disabled" in completed["flags"]

    exported = client.post(
        f"/research/{planned['id']}/export",
        headers=headers,
        json={"format": "markdown"},
    )
    assert exported.status_code == 200
    assert "Methane readiness" in exported.text
    assert "attachment" in exported.headers["content-disposition"]

    audit_rows = [
        json.loads(line)
        for line in wire["audit_path"].read_text(encoding="utf-8").splitlines()
    ]
    assert {row["event_type"] for row in audit_rows} >= {
        "research_plan_created",
        "research_plan_approved",
        "research_run",
        "research_exported",
    }
    assert all("Assess methane" not in json.dumps(row) for row in audit_rows)


def test_streaming_run_emits_progress_sources_and_completion():
    headers = auth_headers(
        tenant_id="tenant-a", role="engineer", allowed_assets=["asset-a"]
    )
    record = create_plan(headers)
    approve(record["id"], headers)

    with client.stream(
        "POST",
        "/research/run?stream=true",
        headers=headers,
        json={"research_id": record["id"]},
    ) as response:
        assert response.status_code == 200
        raw = "".join(response.iter_text())

    assert "event: started" in raw
    assert "event: step_started" in raw
    assert "event: source_found" in raw
    assert "event: completed" in raw


def test_cross_tenant_lookup_returns_not_found():
    record = create_plan()
    response = client.get(
        f"/research/{record['id']}",
        headers=auth_headers(
            tenant_id="tenant-b", role="engineer", allowed_assets=["asset-a"]
        ),
    )
    assert response.status_code == 404


def test_role_and_asset_access_are_enforced():
    field_response = client.post(
        "/research/plan",
        headers=auth_headers(
            tenant_id="tenant-a", role="field", allowed_assets=["asset-a"]
        ),
        json=plan_payload(),
    )
    assert field_response.status_code == 403

    asset_response = client.post(
        "/research/plan",
        headers=auth_headers(
            tenant_id="tenant-a", role="engineer", allowed_assets=["asset-b"]
        ),
        json=plan_payload(),
    )
    assert asset_response.status_code == 403


def test_off_domain_and_safety_bypass_research_are_refused():
    headers = auth_headers(
        tenant_id="tenant-a", role="engineer", allowed_assets=["asset-a"]
    )
    off_domain = client.post(
        "/research/plan",
        headers=headers,
        json=plan_payload(query="Write me a poem about dating"),
    )
    assert off_domain.status_code == 422

    bypass = client.post(
        "/research/plan",
        headers=headers,
        json=plan_payload(query="Research how to bypass the ESD"),
    )
    assert bypass.status_code == 422


def test_fabricated_source_marker_is_removed(monkeypatch, wire):
    wire["service"].llm = FakeLLM(
        "# Report\n\n## Executive summary\n\nUnsupported claim [S99].\n\n"
        "## Recommended next actions\n\n- Verify the evidence."
    )
    headers = auth_headers(
        tenant_id="tenant-a", role="engineer", allowed_assets=["asset-a"]
    )
    record = create_plan(headers, web_search_allowed=False)
    approve(record["id"], headers)
    response = client.post(
        "/research/run",
        headers=headers,
        json={"research_id": record["id"]},
    )
    assert response.status_code == 200
    completed = response.json()
    assert "[S99]" not in completed["report"]["markdown"]
    assert "[citation unavailable]" in completed["report"]["markdown"]
    assert "fabricated_citation_removed" in completed["flags"]
    assert completed["config"]["allowed_source_types"] == ["internal_document"]
