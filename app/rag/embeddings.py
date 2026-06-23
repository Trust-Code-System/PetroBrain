"""Embedding provider abstraction (hosted for Tier A, self-hosted for Tier B)."""
from __future__ import annotations

import logging

from app.config import get_settings

logger = logging.getLogger(__name__)

# User-safe message for ANY embedding-provider failure. The raw provider
# exception must never reach a tenant: an OpenAI 429 body advertises our billing
# page, admits the shared key is out of quota, and names the provider; a vLLM /
# httpx error leaks internal hostnames. We log the full detail for operators and
# surface only this. Wording is deliberately neutral - it does not promise a
# quick retry (an `insufficient_quota` is not transient; it needs an operator).
_SAFE_EMBED_MESSAGE = (
    "the embedding service is currently unavailable. Please try again later, "
    "and contact your administrator if the problem continues."
)


class EmbeddingError(RuntimeError):
    """An embedding-provider call failed. ``str(EmbeddingError)`` is a user-safe
    message only; the underlying provider exception is chained as ``__cause__``
    (for logs/tracebacks) but never embedded in the message text."""


class Embedder:
    def __init__(self) -> None:
        self.settings = get_settings()

    async def embed(self, texts: list[str]) -> list[list[float]]:
        try:
            if self.settings.llm_provider == "self_hosted":
                return await self._self_hosted(texts)
            return await self._hosted(texts)
        except EmbeddingError:
            raise
        except Exception as exc:  # noqa: BLE001 - sanitize every provider error
            logger.warning(
                "embedding_provider_failed error_type=%s error=%s",
                type(exc).__name__, exc,
            )
            raise EmbeddingError(_SAFE_EMBED_MESSAGE) from exc

    async def _hosted(self, texts):
        from openai import AsyncOpenAI  # or any hosted embedding API
        client = AsyncOpenAI()
        resp = await client.embeddings.create(model=self.settings.embedding_model, input=texts)
        return [d.embedding for d in resp.data]

    def _self_hosted_base(self) -> str:
        # A single vLLM serves one model, so embeddings may be hosted separately
        # from chat; fall back to the chat endpoint when not configured.
        return self.settings.embedding_api_base or self.settings.llm_api_base

    async def _self_hosted(self, texts):
        import httpx
        async with httpx.AsyncClient(base_url=self._self_hosted_base(), timeout=60) as c:
            r = await c.post("/v1/embeddings",
                             json={"model": self.settings.embedding_model, "input": texts})
            r.raise_for_status()
            return [d["embedding"] for d in r.json()["data"]]
