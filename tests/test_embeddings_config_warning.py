"""warn_on_degraded_embeddings logs a clear startup warning when embeddings can't
work as configured (missing OpenAI key, or self-hosted with no endpoint), and
stays quiet when they can. It never raises - it's feedback, not a gate."""
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import Settings, warn_on_degraded_embeddings

MARKER = "embeddings_misconfigured"


def _settings(**over) -> Settings:
    return Settings(**over)


def test_hosted_without_openai_key_warns(monkeypatch, caplog):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with caplog.at_level(logging.WARNING):
        warn_on_degraded_embeddings(_settings(llm_provider="anthropic", embedding_api_base=""))
    assert MARKER in caplog.text
    assert "OPENAI_API_KEY" in caplog.text


def test_hosted_with_placeholder_key_warns(monkeypatch, caplog):
    monkeypatch.setenv("OPENAI_API_KEY", "REPLACE_ME_VIA_RUNBOOK")
    with caplog.at_level(logging.WARNING):
        warn_on_degraded_embeddings(_settings(llm_provider="anthropic", embedding_api_base=""))
    assert MARKER in caplog.text


def test_hosted_with_real_key_is_quiet(monkeypatch, caplog):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-realish-key-value")
    with caplog.at_level(logging.WARNING):
        warn_on_degraded_embeddings(_settings(llm_provider="anthropic", embedding_api_base=""))
    assert MARKER not in caplog.text


def test_self_hosted_without_endpoint_warns(monkeypatch, caplog):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with caplog.at_level(logging.WARNING):
        warn_on_degraded_embeddings(
            _settings(llm_provider="self_hosted", embedding_api_base="", llm_api_base="")
        )
    assert MARKER in caplog.text
    assert "PB_EMBEDDING_API_BASE" in caplog.text


def test_self_hosted_with_endpoint_is_quiet(caplog):
    with caplog.at_level(logging.WARNING):
        warn_on_degraded_embeddings(
            _settings(llm_provider="self_hosted", embedding_api_base="http://vllm-embed:8000")
        )
    assert MARKER not in caplog.text


def test_self_hosted_falls_back_to_llm_api_base_is_quiet(caplog):
    with caplog.at_level(logging.WARNING):
        warn_on_degraded_embeddings(
            _settings(llm_provider="self_hosted", embedding_api_base="", llm_api_base="http://vllm:8000")
        )
    assert MARKER not in caplog.text
