"""Unit tests for the Tavily web_search tool."""
import os
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from app.core import web_search


def _settings(api_key: str = "test-key"):
    return SimpleNamespace(tavily_api_key=api_key)


def _http_ok(json_body: dict):
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = json_body
    return response


def test_returns_disabled_payload_when_no_api_key(monkeypatch):
    monkeypatch.setattr(web_search, "get_settings", lambda: _settings(api_key=""))
    result = web_search.run_web_search_tool({"query": "Shell Nigeria"})
    assert result["disabled"] is True
    assert "PB_TAVILY_API_KEY" in result["reason"]
    assert result["results"] == []


def test_happy_path_returns_normalised_results(monkeypatch):
    monkeypatch.setattr(web_search, "get_settings", lambda: _settings())
    tavily_body = {
        "results": [
            {"title": "Bono Holdings", "url": "https://example.com/a",
             "content": "Some snippet about the company."},
            {"title": "Industry note", "url": "https://example.com/b", "content": "B"},
        ],
    }
    client_cm = MagicMock()
    client_cm.__enter__.return_value.post.return_value = _http_ok(tavily_body)
    client_cm.__exit__.return_value = False
    with patch.object(web_search.httpx, "Client", return_value=client_cm) as mock_client:
        result = web_search.run_web_search_tool({"query": "Bono Holdings", "max_results": 5})
    mock_client.assert_called_once()
    # POST body carried the API key + query + max_results.
    posted_body = client_cm.__enter__.return_value.post.call_args.kwargs["json"]
    assert posted_body["api_key"] == "test-key"
    assert posted_body["query"] == "Bono Holdings"
    assert posted_body["max_results"] == 5

    assert result["provider"] == "tavily"
    assert result["query"] == "Bono Holdings"
    assert [r["url"] for r in result["results"]] == [
        "https://example.com/a", "https://example.com/b",
    ]
    assert result["results"][0]["title"] == "Bono Holdings"
    assert result["results"][0]["snippet"].startswith("Some snippet")


def test_clamps_max_results_to_hard_limit(monkeypatch):
    monkeypatch.setattr(web_search, "get_settings", lambda: _settings())
    body = {"results": [{"title": str(i), "url": f"https://x.com/{i}", "content": ""} for i in range(20)]}
    client_cm = MagicMock()
    client_cm.__enter__.return_value.post.return_value = _http_ok(body)
    client_cm.__exit__.return_value = False
    with patch.object(web_search.httpx, "Client", return_value=client_cm):
        result = web_search.run_web_search_tool({"query": "q", "max_results": 999})
    assert len(result["results"]) == web_search.HARD_MAX_RESULTS


def test_provider_500_returns_error_payload_not_exception(monkeypatch):
    monkeypatch.setattr(web_search, "get_settings", lambda: _settings())
    err_response = MagicMock()
    err_response.status_code = 500
    err_response.text = "internal"
    client_cm = MagicMock()
    client_cm.__enter__.return_value.post.return_value = err_response
    client_cm.__exit__.return_value = False
    with patch.object(web_search.httpx, "Client", return_value=client_cm):
        result = web_search.run_web_search_tool({"query": "q"})
    assert result["error"] == "web_search_provider_error"
    assert result["status"] == 500
    assert result["results"] == []


def test_network_error_returns_error_payload(monkeypatch):
    monkeypatch.setattr(web_search, "get_settings", lambda: _settings())
    client_cm = MagicMock()
    client_cm.__enter__.return_value.post.side_effect = web_search.httpx.HTTPError("boom")
    client_cm.__exit__.return_value = False
    with patch.object(web_search.httpx, "Client", return_value=client_cm):
        result = web_search.run_web_search_tool({"query": "q"})
    assert result["error"] == "web_search_network_error"
    assert "boom" in result["detail"]


def test_rejects_empty_query(monkeypatch):
    monkeypatch.setattr(web_search, "get_settings", lambda: _settings())
    with pytest.raises(ValueError):
        web_search.run_web_search_tool({"query": "   "})


def test_rejects_non_dict_input(monkeypatch):
    monkeypatch.setattr(web_search, "get_settings", lambda: _settings())
    with pytest.raises(TypeError):
        web_search.run_web_search_tool("not a dict")  # type: ignore[arg-type]


def test_truncates_long_snippets(monkeypatch):
    monkeypatch.setattr(web_search, "get_settings", lambda: _settings())
    big_content = "x" * 2000
    client_cm = MagicMock()
    client_cm.__enter__.return_value.post.return_value = _http_ok({
        "results": [{"title": "t", "url": "https://x.com/1", "content": big_content}],
    })
    client_cm.__exit__.return_value = False
    with patch.object(web_search.httpx, "Client", return_value=client_cm):
        result = web_search.run_web_search_tool({"query": "q"})
    snippet = result["results"][0]["snippet"]
    assert snippet.endswith("...")
    assert len(snippet) <= 605  # 600 + ellipsis fudge
