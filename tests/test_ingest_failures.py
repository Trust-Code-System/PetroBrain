"""The ingestion failure_reason shown to admins must never leak raw provider
error text (billing state, provider identity, internal hosts, temp paths)."""
from __future__ import annotations

from app.workers.ingest_failures import safe_failure_reason

# The exact shape of the OpenAI quota error that leaked to the admin UI.
_OPENAI_429 = (
    "Error code: 429 - {'error': {'message': 'You exceeded your current quota, "
    "please check your plan and billing details. For more information on this "
    "error, read the docs: https://platform.openai.com/docs/guides/error-codes/"
    "api-errors.', 'type': 'insufficient_quota', 'param': None, 'code': "
    "'insufficient_quota'}}"
)


def _leaks_secrets(reason: str) -> bool:
    lowered = reason.lower()
    return any(
        token in lowered
        for token in ("quota", "billing", "openai", "platform.openai", "http", "{", "error code")
    )


def test_embed_quota_error_is_sanitized():
    reason = safe_failure_reason("embed", RuntimeError(_OPENAI_429))
    assert reason.startswith("embed:")
    assert not _leaks_secrets(reason)
    assert "retry" in reason.lower()


def test_embed_auth_error_is_sanitized():
    reason = safe_failure_reason("embed", RuntimeError("Error code: 401 - invalid_api_key"))
    assert reason.startswith("embed:")
    assert "api_key" not in reason.lower()
    assert "administrator" in reason.lower()


def test_extract_empty_is_specific_but_safe():
    reason = safe_failure_reason("extract", ValueError("extracted document text is empty"))
    assert reason.startswith("extract:")
    assert "no readable text" in reason.lower()


def test_extract_generic_error_hides_internal_detail():
    reason = safe_failure_reason("extract", RuntimeError("/tmp/abc123/upload.pdf: bad xref at 0xDEAD"))
    assert reason.startswith("extract:")
    assert "/tmp" not in reason
    assert "0xdead" not in reason.lower()


def test_dispatch_error_hides_transport_detail():
    reason = safe_failure_reason("dispatch", RuntimeError("No such transport: 'redis://secret-host:6379'"))
    assert reason.startswith("dispatch:")
    assert "secret-host" not in reason
