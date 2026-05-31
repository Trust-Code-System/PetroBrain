"""
Tavily-backed web search tool exposed to the chat orchestrator.

The model invokes this when it needs current public information (companies,
people, regulators, market events, projects) it can't fetch from the tenant's
RAG corpus. The tool returns a small, citation-ready payload so the LLM can
quote a source URL rather than inventing facts.

Tavily was picked for first-cut integration:
    https://docs.tavily.com/docs/rest-api/api-reference

To enable the tool, set ``PB_TAVILY_API_KEY`` in the environment. With no key,
the tool stays registered but returns a structured "disabled" payload so the
model can fall back to declining gracefully rather than hallucinating.
"""
from __future__ import annotations

from typing import Any

import httpx

from app.config import get_settings


TAVILY_ENDPOINT = "https://api.tavily.com/search"
DEFAULT_MAX_RESULTS = 5
HARD_MAX_RESULTS = 10
DEFAULT_TIMEOUT_S = 12.0


WEB_SEARCH_TOOL: dict[str, Any] = {
    "name": "web_search",
    "description": (
        "Search the public internet for up-to-date information about an oil & gas "
        "company, person, regulator, project, asset, or industry event. Use this "
        "when the user asks about something specific you may not have in your "
        "training data (e.g. corporate ownership, recent M&A, current production, "
        "regulatory filings, news headlines). Returns a list of result snippets "
        "with title, URL, and a short content excerpt. Cite the source URLs in your "
        "answer; do not invent details that the results do not support."
    ),
    # Use the repo's OpenAI-style "parameters" key (calc tools follow the same
    # shape); ``app/core/llm_service.py`` translates it to Anthropic's
    # ``input_schema`` for the Messages API.
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Plain-text search query. Be specific - include the "
                "company name, jurisdiction, year, or other disambiguators.",
            },
            "max_results": {
                "type": "integer",
                "description": (
                    f"Max number of result snippets to return "
                    f"(1-{HARD_MAX_RESULTS}, default {DEFAULT_MAX_RESULTS})."
                ),
                "minimum": 1,
                "maximum": HARD_MAX_RESULTS,
            },
        },
        "required": ["query"],
    },
}


def run_web_search_tool(payload: dict[str, Any]) -> dict[str, Any]:
    """Synchronous Tavily search. Returns a JSON-serialisable result for the LLM.

    The orchestrator's tool layer is synchronous; we use ``httpx.Client`` (sync)
    rather than the async client to stay in shape with the other calc tools.
    The orchestrator pipes the dict back to the model as a tool_result block.
    """
    if not isinstance(payload, dict):
        raise TypeError("web_search input must be an object")

    query = payload.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("web_search requires a non-empty 'query' string")

    max_results = payload.get("max_results", DEFAULT_MAX_RESULTS)
    if not isinstance(max_results, int) or max_results < 1:
        max_results = DEFAULT_MAX_RESULTS
    max_results = min(max_results, HARD_MAX_RESULTS)

    settings = get_settings()
    api_key = (settings.tavily_api_key or "").strip()
    if not api_key:
        # Stay registered so the LLM doesn't see "unknown_tool" - returning a
        # disabled marker lets it tell the user web search is offline and fall
        # back to its training data with appropriate caveats.
        return {
            "disabled": True,
            "reason": "PB_TAVILY_API_KEY is not configured",
            "query": query.strip(),
            "results": [],
        }

    body = {
        "api_key": api_key,
        "query": query.strip(),
        "max_results": max_results,
        "search_depth": "basic",
        "include_answer": False,
        "include_raw_content": False,
    }

    try:
        with httpx.Client(timeout=DEFAULT_TIMEOUT_S) as client:
            resp = client.post(TAVILY_ENDPOINT, json=body)
    except httpx.HTTPError as exc:
        return {
            "error": "web_search_network_error",
            "detail": str(exc),
            "query": query.strip(),
            "results": [],
        }

    if resp.status_code != 200:
        return {
            "error": "web_search_provider_error",
            "status": resp.status_code,
            "detail": resp.text[:500],
            "query": query.strip(),
            "results": [],
        }

    try:
        data = resp.json()
    except ValueError:
        return {
            "error": "web_search_invalid_response",
            "query": query.strip(),
            "results": [],
        }

    raw_results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(raw_results, list):
        raw_results = []

    results: list[dict[str, Any]] = []
    for item in raw_results[:max_results]:
        if not isinstance(item, dict):
            continue
        results.append({
            "title": _str_or_none(item.get("title")),
            "url": _str_or_none(item.get("url")),
            "snippet": _truncate(_str_or_none(item.get("content")), 600),
        })

    return {
        "query": query.strip(),
        "provider": "tavily",
        "results": results,
    }


def _str_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _truncate(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    if len(value) <= limit:
        return value
    return value[:limit].rstrip() + "..."
