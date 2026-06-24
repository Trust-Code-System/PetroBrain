"""User-safe failure messages for the document ingestion pipeline.

Raw provider / parser exceptions routinely carry detail that must NOT reach a
tenant's screen: an OpenAI ``429`` body advertises our billing page and admits
the shared key is out of quota, vLLM/asyncpg errors leak internal hostnames,
and pdf parsers leak temp file paths. Those belong in the server log only.

``safe_failure_reason`` maps an exception to a short, stable, non-sensitive
string (keeping the ``<stage>:`` prefix the UI and tests rely on) so the
``failure_reason`` persisted on a document and shown in the admin table never
exposes third-party error text. Callers should log the full exception
separately for operators.
"""
from __future__ import annotations

_QUOTA_OR_RATE = (
    "429", "quota", "insufficient_quota", "rate limit", "rate_limit",
    "too many requests", "billing",
)
_AUTH = (
    "401", "403", "api key", "api_key", "unauthorized", "authentication",
    "invalid_api_key", "permission",
)


def safe_failure_reason(stage: str, exc: BaseException) -> str:
    """Return a user-safe ``"<stage>: ..."`` reason for a pipeline failure."""
    text = str(exc).lower()
    if stage == "embed":
        if _contains(text, _QUOTA_OR_RATE):
            return (
                "embed: embedding service is temporarily unavailable "
                "(rate limited or at capacity). Please retry shortly."
            )
        if _contains(text, _AUTH):
            return "embed: embedding service is misconfigured. Contact your administrator."
        return (
            "embed: could not generate embeddings for this document. "
            "Please retry; contact support if this keeps happening."
        )
    if stage == "extract":
        if "empty" in text:
            return "extract: no readable text was found in the document."
        return (
            "extract: could not read the document. Confirm it is a valid, "
            "non-corrupt PDF, DOCX, or text file and try again."
        )
    if stage == "dispatch":
        return "dispatch: ingestion could not be queued. Please retry shortly."
    return f"{stage}: processing failed. Please retry."


def _contains(text: str, needles: tuple[str, ...]) -> bool:
    return any(n in text for n in needles)
