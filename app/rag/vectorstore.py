"""
pgvector-backed store with strict per-tenant isolation.

Phase-1 choice: vectors live in Postgres (pgvector) - one fewer system to operate.
Tenant isolation is enforced in the query (and should also be enforced by Postgres
row-level security). The retriever NEVER issues a query without a tenant filter.
"""
from __future__ import annotations

import math
from typing import Any

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS doc_chunks (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    document_id  TEXT NOT NULL,
    title        TEXT,
    revision     TEXT,
    jurisdiction TEXT,
    asset        TEXT,
    clause       TEXT,
    effective_date DATE,
    text         TEXT NOT NULL,
    embedding    vector(3072),
    tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON doc_chunks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_chunks_tsv ON doc_chunks USING GIN(tsv);
-- vector index (HNSW) created after bulk load for performance
"""


class VectorStore:
    def __init__(self, pool) -> None:
        self.pool = pool  # asyncpg pool

    async def upsert(self, rows: list[dict[str, Any]]) -> int:
        tenant_id = _tenant_id_for_rows(rows)
        q = """INSERT INTO doc_chunks
               (tenant_id, document_id, title, revision, jurisdiction, asset, clause,
                effective_date, text, embedding)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)"""
        async with self.pool.acquire() as con:
            async with con.transaction():
                await _set_tenant_context(con, tenant_id)
                await con.executemany(q, [
                    (r["tenant_id"], r["document_id"], r.get("title"), r.get("revision"),
                     r.get("jurisdiction"), r.get("asset"), r.get("clause"),
                     r.get("effective_date"), r["text"], _pgvector_literal(r["embedding"]))
                    for r in rows
                ])
        return len(rows)

    async def delete_document(self, *, tenant_id: str, document_id: str) -> int:
        """Remove every chunk for ``document_id`` within the tenant.

        Returns the number of rows deleted. The tenant filter is mandatory and
        first (mirrors :meth:`hybrid_search`) so a delete can never reach across
        tenants even if the GUC/RLS backstop were misconfigured.
        """
        tenant_id = _require_tenant_id(tenant_id)
        if not isinstance(document_id, str) or not document_id.strip():
            raise ValueError("document_id is required to delete chunks")
        async with self.pool.acquire() as con:
            async with con.transaction():
                await _set_tenant_context(con, tenant_id)
                status = await con.execute(
                    "DELETE FROM doc_chunks WHERE tenant_id = $1 AND document_id = $2",
                    tenant_id, document_id,
                )
        # asyncpg returns a command tag like "DELETE 3"; parse the row count.
        try:
            return int(status.split()[-1])
        except (AttributeError, ValueError, IndexError):
            return 0

    async def hybrid_search(self, tenant_id: str, query_text: str,
                            query_embedding: list[float], top_k: int,
                            asset: str | None = None,
                            assets: list[str] | None = None) -> list[dict[str, Any]]:
        """
        Dense (vector cosine) + sparse (full-text) fused by reciprocal-rank fusion.
        Tenant filter is mandatory and first.

        ``assets`` (A9): if provided, matches any chunk whose ``asset`` is in
        the list - the orchestrator passes the asset plus all of its ancestors
        so a query bound to a leaf still pulls SOPs filed at the parent train
        or field. A NULL asset (tenant-wide doc) is always included.
        """
        tenant_id = _require_tenant_id(tenant_id)
        asset_list = _normalize_asset_filter(asset, assets)
        asset_filter = "AND (asset = ANY($4::text[]) OR asset IS NULL)" if asset_list else ""
        params: list[Any] = [tenant_id, _pgvector_literal(query_embedding), top_k]
        if asset_list:
            params.append(asset_list)
        dense = f"""
            SELECT id, document_id, title, revision, clause, text,
                   1 - (embedding <=> $2) AS score, 'dense' AS src
            FROM doc_chunks
            WHERE tenant_id = $1 {asset_filter}
            ORDER BY embedding <=> $2 LIMIT $3"""
        sparse = f"""
            SELECT id, document_id, title, revision, clause, text,
                   ts_rank(tsv, plainto_tsquery('english', $2)) AS score, 'sparse' AS src
            FROM doc_chunks
            WHERE tenant_id = $1 AND tsv @@ plainto_tsquery('english', $2) {asset_filter}
            ORDER BY score DESC LIMIT $3"""
        async with self.pool.acquire() as con:
            async with con.transaction():
                await _set_tenant_context(con, tenant_id)
                d = await con.fetch(dense, *params)
                sp_params: list[Any] = [tenant_id, query_text, top_k]
                if asset_list:
                    sp_params.append(asset_list)
                s = await con.fetch(sparse, *sp_params)
        return _reciprocal_rank_fusion([dict(r) for r in d], [dict(r) for r in s])


def _normalize_asset_filter(asset: str | None, assets: list[str] | None) -> list[str]:
    """Merge the legacy single-asset filter with the A9 multi-asset list."""
    items: list[str] = []
    if assets:
        for a in assets:
            if a and a not in items:
                items.append(a)
    if asset and asset not in items:
        items.append(asset)
    return items


def _require_tenant_id(tenant_id: Any) -> str:
    if not isinstance(tenant_id, str) or not tenant_id.strip():
        raise ValueError("tenant_id is required for tenant-isolated vectorstore access")
    return tenant_id.strip()


async def _set_tenant_context(con, tenant_id: str) -> None:
    await con.execute("SELECT set_config('petrobrain.tenant_id', $1, true)", tenant_id)


def _tenant_id_for_rows(rows: list[dict[str, Any]]) -> str:
    if not rows:
        raise ValueError("at least one row is required for vectorstore upsert")
    tenant_ids = {_require_tenant_id(r.get("tenant_id")) for r in rows}
    if len(tenant_ids) != 1:
        raise ValueError("vectorstore upsert rows must belong to one tenant")
    return next(iter(tenant_ids))


def _pgvector_literal(embedding: Any) -> str:
    """Serialize a Python embedding list to pgvector's text input format.

    asyncpg does not know how to adapt Python lists to the pgvector extension's
    vector type unless a custom codec is registered on every connection.
    Passing the canonical text literal keeps inserts and vector searches working
    with plain asyncpg pools.
    """
    if not isinstance(embedding, (list, tuple)) or not embedding:
        raise ValueError("embedding must be a non-empty numeric list")
    parts: list[str] = []
    for value in embedding:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("embedding values must be numeric")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise ValueError("embedding values must be finite")
        parts.append(str(numeric))
    return "[" + ",".join(parts) + "]"


def _reciprocal_rank_fusion(dense, sparse, k: int = 60):
    scores: dict[int, dict] = {}
    for ranked in (dense, sparse):
        for rank, row in enumerate(ranked):
            rid = row["id"]
            scores.setdefault(rid, {"row": row, "rrf": 0.0})
            scores[rid]["rrf"] += 1.0 / (k + rank + 1)
    fused = sorted(scores.values(), key=lambda x: x["rrf"], reverse=True)
    out = []
    for item in fused:
        r = item["row"]
        out.append({"id": r["id"], "text": r["text"], "title": r["title"],
                    "revision": r["revision"], "clause": r["clause"], "rrf": item["rrf"]})
    return out
