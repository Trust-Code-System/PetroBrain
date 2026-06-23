"""Embedding-provider failures are sanitized: the raw provider body (OpenAI 429
quota text, internal hostnames) never reaches a tenant, and a dead embedder
degrades retrieval to no-hits instead of failing the whole chat turn."""
import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.rag.embeddings import _SAFE_EMBED_MESSAGE, Embedder, EmbeddingError
from app.rag.retriever import Retriever

# Verbatim shape of the OpenAI quota error users were seeing in the admin UI.
_RAW_OPENAI_429 = (
    "Error code: 429 - {'error': {'message': 'You exceeded your current quota, "
    "please check your plan and billing details. For more information on this "
    "error, read the docs: https://platform.openai.com/docs/guides/error-codes/"
    "api-errors.', 'type': 'insufficient_quota', 'param': None, "
    "'code': 'insufficient_quota'}}"
)
_LEAK_TOKENS = ("429", "quota", "billing", "openai", "insufficient_quota", "http")


def test_provider_error_is_wrapped_in_sanitized_embedding_error():
    emb = Embedder()

    async def boom(_texts):
        raise RuntimeError(_RAW_OPENAI_429)

    emb._hosted = boom  # type: ignore[method-assign]

    with pytest.raises(EmbeddingError) as exc_info:
        asyncio.run(emb.embed(["some chunk text"]))

    message = str(exc_info.value)
    assert message == _SAFE_EMBED_MESSAGE
    # None of the leaky provider tokens survive into the user-facing message.
    lowered = message.lower()
    for token in _LEAK_TOKENS:
        assert token not in lowered
    # The raw exception is preserved on the chain for operators / logs only.
    assert isinstance(exc_info.value.__cause__, RuntimeError)
    assert "insufficient_quota" in str(exc_info.value.__cause__)


def test_committed_ingest_failure_reason_would_be_safe():
    """The deployed ingest worker persists ``f"embed: {exc}"``. With the wrapped
    error, that rendered string is now safe - this is the exact prod path."""
    err = EmbeddingError(_SAFE_EMBED_MESSAGE)
    rendered = f"embed: {err}"
    assert rendered.startswith("embed: ")
    for token in _LEAK_TOKENS:
        assert token not in rendered.lower()


def test_embedding_error_passes_through_unwrapped():
    """An EmbeddingError raised lower down is not double-wrapped."""
    emb = Embedder()
    sentinel = EmbeddingError(_SAFE_EMBED_MESSAGE)

    async def reraise(_texts):
        raise sentinel

    emb._hosted = reraise  # type: ignore[method-assign]
    with pytest.raises(EmbeddingError) as exc_info:
        asyncio.run(emb.embed(["x"]))
    assert exc_info.value is sentinel


class _DeadEmbedder:
    async def embed(self, _texts):
        raise EmbeddingError(_SAFE_EMBED_MESSAGE)


def test_retriever_degrades_to_no_hits_when_embedding_unavailable():
    # reranker is a non-None sentinel so __init__ does not try to load a model.
    retriever = Retriever(store=object(), embedder=_DeadEmbedder(), reranker=object())  # type: ignore[arg-type]
    hits = asyncio.run(retriever.retrieve("what is the kill sheet procedure?", tenant_id="t1"))
    assert hits == []
