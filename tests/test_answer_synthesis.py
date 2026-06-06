"""Structured answer synthesis, source quality, and citation integrity."""
from __future__ import annotations

import pytest

from app.core.answer_synthesis import (
    AnswerSynthesisRequest,
    AnswerSynthesisService,
)
from app.core.llm_service import LLMResponse


SECTOR_ANSWER = """# Nigerian Upstream Oil and Gas Sector Overview

## Executive summary
Nigeria's upstream sector is governed through the Petroleum Industry Act and
NUPRC oversight [S1].

## Sector structure
The sector includes national, international, and indigenous operators [S1].

## Key regulators
- NUPRC regulates upstream petroleum operations [S1].

## Major operators
Operator positions should be verified against current company filings [S2].

## Licensing and asset structure
Licensing claims require current regulator confirmation [S1].

## Gas commercialization
Gas commercialization remains a material development theme [S1].

## Emissions and ESG pressure
Methane and flare performance face increasing scrutiny [S1].

## Current challenges
- Security, funding, infrastructure, and regulatory execution.

## Investment opportunities
- Gas infrastructure and emissions-reduction projects.

## Risks and watchpoints
- Verify fiscal and licensing terms before investment.

## What I checked
- Official regulator evidence.

## What I could not verify
- Current operator production rankings.

## Confidence
Medium.

## Sources / citations
- [S1] NUPRC
- [S2] Company filing
"""


DEEP_RESEARCH_ANSWER = """# Nigeria Gas Flare Commercialization Opportunity

## Research objective
Assess the regulated commercial opportunity.

## Executive summary
Flare commercialization may create gas-supply and emissions benefits [S1].

## Regulatory background
NUPRC is the primary upstream regulator for the evidence reviewed [S1].

## Commercial opportunity
Projects require site-specific gas quality, volume, uptime, and offtake data [S1].

## Emissions benefit
Benefits depend on measured baseline flaring and project performance [S1].

## Investor risks
- Feedstock reliability and permitting.

## Key stakeholders
- Regulator, producer, host communities, offtakers, and financiers.

## Implementation considerations
- Validate metering and commercial terms.

## What I checked
- Official regulator source.

## What I could not verify
- Site-specific economics.

## Confidence
Medium.

## Sources / citations
- [S1] NUPRC
"""


class FakeLLM:
    def __init__(self, answer: str):
        self.answer = answer
        self.calls = []

    async def complete(self, system, messages, tools=None, thinking_mode="default"):
        self.calls.append(
            {
                "system": system,
                "messages": messages,
                "tools": tools,
                "thinking_mode": thinking_mode,
            }
        )
        return LLMResponse(
            text=self.answer,
            tool_calls=[],
            usage={"input": 100, "output": 300},
            model="fake-synthesis",
        )


def official_source(**overrides):
    row = {
        "title": "NUPRC upstream sector update",
        "url": "https://nuprc.gov.ng/upstream-sector",
        "snippet": (
            "Nigeria upstream petroleum regulation, licensing, operators, gas "
            "development, flaring, methane, and investment."
        ),
        "published_at": "2026-01-15",
    }
    row.update(overrides)
    return row


@pytest.mark.asyncio
async def test_sector_overview_is_structured_and_not_raw_snippets():
    llm = FakeLLM(SECTOR_ANSWER)
    service = AnswerSynthesisService(llm=llm)
    result = await service.synthesize(
        AnswerSynthesisRequest(
            original_question=(
                "Give me a full overview of the Nigerian upstream oil and gas "
                "sector, including regulators, operators, licensing, gas, "
                "emissions, and investment opportunities."
            ),
            tenant_id="tenant-a",
            jurisdiction="Nigeria",
            web_search_results=[
                official_source(),
                {
                    "title": "Company annual report",
                    "url": "https://operator.example/investors/annual-report",
                    "snippet": "Nigeria upstream operator portfolio and current assets.",
                },
            ],
            web_search_attempted=True,
        )
    )

    assert "## Executive summary" in result.final_answer_markdown
    assert "## Key regulators" in result.final_answer_markdown
    assert "## Investment opportunities" in result.final_answer_markdown
    assert "I found current public sources" not in result.final_answer_markdown
    assert "Based on the returned snippets" not in result.final_answer_markdown
    assert result.citations[0]["url"].startswith("https://nuprc.gov.ng")
    assert result.evidence_pack["checked"]


@pytest.mark.asyncio
async def test_deep_research_returns_report_structure():
    service = AnswerSynthesisService(llm=FakeLLM(DEEP_RESEARCH_ANSWER))
    result = await service.synthesize(
        AnswerSynthesisRequest(
            original_question=(
                "Run a deep research report on Nigeria's gas flare "
                "commercialization opportunity"
            ),
            tenant_id="tenant-a",
            jurisdiction="Nigeria",
            report_type="deep_research",
            web_search_results=[official_source()],
            web_search_attempted=True,
        )
    )

    assert "## Regulatory background" in result.final_answer_markdown
    assert "## Commercial opportunity" in result.final_answer_markdown
    assert "## Emissions benefit" in result.final_answer_markdown
    assert "## Investor risks" in result.final_answer_markdown


def test_web_search_disabled_has_graceful_verification_gap():
    prepared = AnswerSynthesisService(llm=FakeLLM("unused")).prepare(
        AnswerSynthesisRequest(
            original_question="What is the current Nigerian licensing position?",
            tenant_id="tenant-a",
            web_search_enabled=False,
        )
    )

    assert prepared.confidence_label == "Low"
    assert any(
        "Current public web sources were not available" in item
        for item in prepared.not_verified_items
    )


def test_weak_sources_are_labeled_and_irrelevant_sources_are_filtered():
    prepared = AnswerSynthesisService(llm=FakeLLM("unused")).prepare(
        AnswerSynthesisRequest(
            original_question="Nigeria upstream petroleum licensing",
            tenant_id="tenant-a",
            web_search_results=[
                {
                    "title": "Nigeria upstream licensing blog",
                    "url": "https://random-energy-blog.example/post",
                    "snippet": "Nigeria upstream petroleum licensing commentary.",
                },
                {
                    "title": "Electricity consumer tariff guide",
                    "url": "https://electricity.example/tariff",
                    "snippet": "Residential power billing and consumer meters.",
                },
            ],
            web_search_attempted=True,
        )
    )

    assert len(prepared.sources) == 1
    assert prepared.sources[0]["reliability"] in {"medium", "low"}
    assert prepared.audit_metadata["filtered_irrelevant_source_count"] == 1
    assert any("secondary" in item.lower() for item in prepared.not_verified_items)


def test_fabricated_source_marker_and_url_are_removed():
    service = AnswerSynthesisService(llm=FakeLLM("unused"))
    prepared = service.prepare(
        AnswerSynthesisRequest(
            original_question="Nigeria upstream sector",
            tenant_id="tenant-a",
            web_search_results=[official_source()],
            web_search_attempted=True,
        )
    )
    result = service.finalize(
        prepared,
        text=(
            "# Answer\n\nUnsupported [S99]. "
            "[Official source](https://nuprc.gov.ng/upstream-sector). "
            "[Fake source](https://fabricated.example/report). "
            "Also https://fabricated.example/raw"
        ),
    )

    assert "[S99]" not in result.final_answer_markdown
    assert "Official source [S1]" in result.final_answer_markdown
    assert "https://nuprc.gov.ng" not in result.final_answer_markdown
    assert "https://fabricated.example" not in result.final_answer_markdown
    assert result.final_answer_markdown.count("[citation unavailable]") == 3
    assert "fabricated_citation_removed" in result.flags
