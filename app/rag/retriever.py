"""
Retriever: embed query -> hybrid search -> per-tenant weight nudge -> cross-
encoder rerank -> top-N with metadata. Returns citation-grade hits
(document, revision, clause) for the orchestrator.

Per-tenant weight nudge (slice 3 of the learning loop): after RRF fusion and
before the cross-encoder reranks, each chunk's score is multiplied by the
tenant-scoped weight from ``tenant_chunk_weights`` (default 1.0 if no
feedback has touched it yet). The weight is bounded [0.5, 1.5] in the
repository, so heavy negative feedback cannot remove a chunk from retrieval
- the reranker still sees it, the model still gets a chance to cite it. The
order changes; the population doesn't.
"""
from __future__ import annotations

import logging
from typing import Any

from app.config import get_settings
from app.rag.embeddings import Embedder
from app.rag.reranker import Reranker
from app.rag.vectorstore import VectorStore, _require_tenant_id

logger = logging.getLogger(__name__)


class Retriever:
    def __init__(self, store: VectorStore, embedder: Embedder | None = None,
                 reranker=None) -> None:
        self.store = store
        self.embedder = embedder or Embedder()
        self.settings = get_settings()
        self.reranker = reranker
        if self.reranker is None and self.settings.rerank_enabled:
            self.reranker = Reranker(
                model_name=self.settings.rerank_model,
                cache_dir=self.settings.rerank_cache_dir,
            )

    async def retrieve(self, query: str, *, tenant_id: str,
                       asset: str | None = None,
                       assets: list[str] | None = None) -> list[dict[str, Any]]:
        """
        ``assets`` (A9) is the asset_id plus its ancestors so a query about a
        single piece of equipment can still surface SOPs filed against the
        parent train/block/field. When ``assets`` is provided it takes
        precedence over the legacy ``asset`` single-value filter.
        """
        tenant_id = _require_tenant_id(tenant_id)
        [q_emb] = await self.embedder.embed([query])
        hits = await self.store.hybrid_search(
            tenant_id=tenant_id, query_text=query, query_embedding=q_emb,
            top_k=self.settings.retrieval_top_k,
            asset=asset, assets=assets,
        )
        # Slice 3: apply per-tenant weight nudge to the fused score, then
        # re-sort so the rerank input order reflects user feedback. Bounded
        # to [floor, ceiling] in the repository, so this can never zero a
        # chunk or push it past the ceiling.
        hits = _apply_tenant_weights(hits, tenant_id=tenant_id)
        if self.reranker and hits:
            hits = self.reranker.rerank(query, hits)
        return hits[: self.settings.rerank_top_n]


def _apply_tenant_weights(
    hits: list[dict[str, Any]], *, tenant_id: str,
) -> list[dict[str, Any]]:
    if not hits:
        return hits
    chunk_ids = [int(h["id"]) for h in hits if isinstance(h.get("id"), (int, float))]
    if not chunk_ids:
        return hits
    try:
        from app.db.chunk_weights_repository import get_chunk_weights_repository

        weights = get_chunk_weights_repository().get_weights(
            tenant_id=tenant_id, chunk_ids=chunk_ids,
        )
    except Exception as exc:  # noqa: BLE001 - never let weighting break retrieval
        logger.warning("chunk_weight_lookup_failed", extra={"error": str(exc)})
        return hits
    if not weights:
        return hits  # no per-tenant signal yet; default 1.0 for every chunk
    for h in hits:
        w = weights.get(int(h.get("id", -1)), 1.0)
        # rrf is the fused score from app.rag.vectorstore._reciprocal_rank_fusion
        if "rrf" in h:
            h["rrf"] = float(h["rrf"]) * float(w)
        h["tenant_weight"] = float(w)
    hits.sort(key=lambda h: float(h.get("rrf", 0.0)), reverse=True)
    return hits
