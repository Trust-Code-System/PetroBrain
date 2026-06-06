"""Source filtering, deduplication, reliability, and freshness for research."""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any
from urllib.parse import urlparse


PRIMARY_DOMAINS = {
    "nuprc.gov.ng",
    "nmdpra.gov.ng",
    "ncdmb.gov.ng",
    "opec.org",
    "iea.org",
    "eia.gov",
    "energy.gov",
    "epa.gov",
    "sec.gov",
    "gov.uk",
}

HIGH_RELIABILITY_DOMAINS = {
    "worldbank.org",
    "imf.org",
    "unfccc.int",
    "ipcc.ch",
    "ogmpartnership.com",
    "iso.org",
}


def normalize_domain(url_or_domain: str | None) -> str:
    if not url_or_domain:
        return ""
    raw = url_or_domain.strip().lower()
    if "://" not in raw:
        raw = "https://" + raw
    try:
        host = urlparse(raw).hostname or ""
    except ValueError:
        return ""
    return host.removeprefix("www.")


def domain_allowed(url: str | None, allowed_domains: list[str]) -> bool:
    if not allowed_domains:
        return True
    host = normalize_domain(url)
    return any(host == domain or host.endswith("." + domain) for domain in allowed_domains)


def reliability_for(source: dict[str, Any]) -> tuple[str, str]:
    if source.get("source_type") == "internal_document":
        return "primary", "Tenant-controlled internal document."
    host = normalize_domain(source.get("url"))
    if (
        any(host == domain or host.endswith("." + domain) for domain in PRIMARY_DOMAINS)
        or host.endswith((".gov", ".gov.ng"))
    ):
        return "primary", "Official regulator, government, or intergovernmental source."
    if any(
        host == domain or host.endswith("." + domain)
        for domain in HIGH_RELIABILITY_DOMAINS
    ):
        return "high", "Recognized standards, multilateral, or technical institution."
    if host:
        return "medium", "Public web source; verify important claims against a primary source."
    return "unknown", "Source URL was unavailable."


def freshness_for(
    published_at: str | None,
    *,
    date_from: date | None,
    date_to: date | None,
) -> tuple[str, bool]:
    if not published_at:
        return "unknown", False
    try:
        parsed = datetime.fromisoformat(published_at.replace("Z", "+00:00")).date()
    except (TypeError, ValueError):
        return "unknown", False
    if date_from and parsed < date_from:
        return "dated", True
    if date_to and parsed > date_to:
        return "dated", True
    current_year = datetime.now(timezone.utc).year
    return ("current", False) if parsed.year >= current_year - 2 else ("dated", True)


def dedupe_sources(sources: list[dict[str, Any]], maximum: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for source in sources:
        if source.get("source_type") == "web":
            key = ("web", (source.get("url") or "").rstrip("/").lower())
        else:
            key = (
                "internal_document",
                "|".join(
                    str(source.get(k) or "").lower()
                    for k in ("document_id", "revision", "clause", "snippet")
                ),
            )
        if not key[1] or key in seen:
            continue
        seen.add(key)
        out.append(source)
        if len(out) >= maximum:
            break
    return out


def annotate_sources(
    sources: list[dict[str, Any]],
    *,
    date_from: date | None,
    date_to: date | None,
) -> tuple[list[dict[str, Any]], list[str]]:
    annotated: list[dict[str, Any]] = []
    outdated: list[str] = []
    for index, source in enumerate(sources, start=1):
        reliability, reason = reliability_for(source)
        freshness, is_outdated = freshness_for(
            source.get("published_at"), date_from=date_from, date_to=date_to
        )
        row = {
            **source,
            "id": f"S{index}",
            "reliability": reliability,
            "reliability_reason": reason,
            "freshness": freshness,
        }
        annotated.append(row)
        if is_outdated:
            outdated.append(f"{row['id']}: {row.get('title') or 'Untitled source'}")
    return annotated, outdated
