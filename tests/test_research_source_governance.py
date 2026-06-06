"""Research source allowlisting, deduplication, reliability, and freshness tests."""
from datetime import date

from app.research.source_governance import (
    annotate_sources,
    dedupe_sources,
    domain_allowed,
    normalize_domain,
)


def test_domain_allowlist_accepts_subdomains_and_rejects_lookalikes():
    assert normalize_domain("https://www.NUPRC.gov.ng/guidance") == "nuprc.gov.ng"
    assert domain_allowed("https://docs.nuprc.gov.ng/methane", ["nuprc.gov.ng"])
    assert not domain_allowed("https://nuprc.gov.ng.attacker.example", ["nuprc.gov.ng"])
    assert not domain_allowed(None, ["nuprc.gov.ng"])


def test_deduplication_preserves_first_source_and_enforces_limit():
    sources = [
        {
            "source_type": "web",
            "title": "Official guidance",
            "url": "https://nuprc.gov.ng/guidance/",
        },
        {
            "source_type": "web",
            "title": "Duplicate",
            "url": "https://nuprc.gov.ng/guidance",
        },
        {
            "source_type": "internal_document",
            "title": "Procedure",
            "document_id": "SOP-1",
            "revision": "B",
            "clause": "4.2",
            "snippet": "Controlled text",
        },
    ]

    result = dedupe_sources(sources, maximum=2)

    assert [row["title"] for row in result] == ["Official guidance", "Procedure"]


def test_annotation_marks_primary_sources_and_out_of_range_dates():
    annotated, outdated = annotate_sources(
        [
            {
                "source_type": "web",
                "title": "Regulator notice",
                "url": "https://nuprc.gov.ng/notices/1",
                "published_at": "2024-02-01",
            },
            {
                "source_type": "internal_document",
                "title": "Controlled procedure",
                "document_id": "SOP-1",
                "revision": "C",
                "clause": "5",
                "snippet": "Evidence",
                "published_at": "2026-02-01",
            },
        ],
        date_from=date(2025, 1, 1),
        date_to=date(2026, 12, 31),
    )

    assert annotated[0]["id"] == "S1"
    assert annotated[0]["reliability"] == "primary"
    assert annotated[0]["freshness"] == "dated"
    assert annotated[1]["reliability"] == "primary"
    assert outdated == ["S1: Regulator notice"]


def test_official_regulator_subdomain_is_primary():
    annotated, _ = annotate_sources(
        [
            {
                "source_type": "web",
                "title": "Regulator guidance",
                "url": "https://docs.nuprc.gov.ng/guidance",
            }
        ],
        date_from=None,
        date_to=None,
    )

    assert annotated[0]["reliability"] == "primary"
