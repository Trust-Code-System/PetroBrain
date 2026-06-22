"""
Tenant-isolation regression tests.

The RAG layer must be unable to query or write tenant-scoped data without an explicit
tenant_id. These tests use fakes rather than Postgres so they run in the normal suite.
"""
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from app.rag.retriever import Retriever
from app.rag.vectorstore import VectorStore, _set_tenant_context


class FakeAcquire:
    def __init__(self, con):
        self.con = con

    async def __aenter__(self):
        return self.con

    async def __aexit__(self, exc_type, exc, tb):
        return False


class FakeTransaction:
    def __init__(self, con):
        self.con = con

    async def __aenter__(self):
        self.con.events.append(("transaction_begin",))
        return self

    async def __aexit__(self, exc_type, exc, tb):
        self.con.events.append(("transaction_end",))
        return False


class FakePool:
    def __init__(self):
        self.con = FakeConnection()

    def acquire(self):
        return FakeAcquire(self.con)


class FakeConnection:
    def __init__(self):
        self.current_tenant = None
        self.events = []
        self.execute_calls = []
        self.fetch_calls = []
        self.executemany_calls = []

    def transaction(self):
        return FakeTransaction(self)

    async def execute(self, query, *params):
        self.execute_calls.append((query, params))
        self.events.append(("execute", query, params))
        if "set_config('petrobrain.tenant_id'" in query:
            self.current_tenant = params[0]

    async def fetch(self, query, *params):
        self.fetch_calls.append((query, params))
        self.events.append(("fetch", query, params))
        if "'dense'" in query:
            return [
                {
                    "id": 1,
                    "document_id": "sop-a",
                    "title": "Tenant SOP",
                    "revision": "Rev 1",
                    "clause": "1",
                    "text": "Tenant-scoped text",
                    "score": 0.9,
                    "src": "dense",
                }
            ]
        return []

    async def executemany(self, query, rows):
        self.executemany_calls.append((query, rows))
        self.events.append(("executemany", query, rows))


class FakeRLSConnection(FakeConnection):
    def __init__(self):
        super().__init__()
        self.rows = [
            {"id": 1, "tenant_id": "tenant-a", "text": "Tenant A SOP"},
            {"id": 2, "tenant_id": "tenant-b", "text": "Tenant B SOP"},
        ]

    async def fetch(self, query, *params):
        self.fetch_calls.append((query, params))
        self.events.append(("fetch", query, params))
        return [row for row in self.rows if row["tenant_id"] == self.current_tenant]


class FakeEmbedder:
    def __init__(self):
        self.calls = 0

    async def embed(self, texts):
        self.calls += 1
        return [[0.1, 0.2] for _ in texts]


class FakeSearchStore:
    def __init__(self):
        self.calls = []

    async def hybrid_search(self, **kwargs):
        self.calls.append(kwargs)
        return [
            {
                "id": 1,
                "title": "Tenant SOP",
                "revision": "Rev 1",
                "clause": "1",
                "text": "Tenant text",
                "rrf": 0.1,
            }
        ]


class NoopReranker:
    def rerank(self, query, hits):
        return hits


def valid_row(tenant_id="tenant-a"):
    return {
        "tenant_id": tenant_id,
        "document_id": "sop-1",
        "title": "SOP",
        "revision": "Rev 1",
        "jurisdiction": "Nigeria",
        "asset": "Rig-7",
        "clause": "1",
        "effective_date": None,
        "text": "1 Scope\nText",
        "embedding": [0.1, 0.2],
    }


def test_vectorstore_upsert_rejects_missing_tenant_before_db_call():
    pool = FakePool()
    store = VectorStore(pool)

    with pytest.raises(ValueError, match="tenant_id is required"):
        asyncio.run(store.upsert([valid_row(tenant_id="")]))

    assert pool.con.executemany_calls == []


def test_vectorstore_upsert_passes_tenant_in_insert_rows():
    pool = FakePool()
    store = VectorStore(pool)

    count = asyncio.run(store.upsert([valid_row("tenant-a")]))

    assert count == 1
    _, rows = pool.con.executemany_calls[0]
    assert rows[0][0] == "tenant-a"


def test_vectorstore_upsert_serializes_embedding_for_pgvector():
    pool = FakePool()
    store = VectorStore(pool)

    asyncio.run(store.upsert([valid_row("tenant-a")]))

    _, rows = pool.con.executemany_calls[0]
    assert rows[0][9] == "[0.1,0.2]"


def test_vectorstore_upsert_sets_transaction_scoped_tenant_context_before_insert():
    pool = FakePool()
    store = VectorStore(pool)

    asyncio.run(store.upsert([valid_row("tenant-a")]))

    assert pool.con.execute_calls[0] == (
        "SELECT set_config('petrobrain.tenant_id', $1, true)",
        ("tenant-a",),
    )
    event_names = [event[0] for event in pool.con.events]
    assert event_names[:3] == ["transaction_begin", "execute", "executemany"]


def test_vectorstore_upsert_rejects_mixed_tenants_before_db_call():
    pool = FakePool()
    store = VectorStore(pool)

    with pytest.raises(ValueError, match="rows must belong to one tenant"):
        asyncio.run(store.upsert([valid_row("tenant-a"), valid_row("tenant-b")]))

    assert pool.con.execute_calls == []
    assert pool.con.executemany_calls == []


def test_vectorstore_hybrid_search_rejects_missing_tenant_before_db_call():
    pool = FakePool()
    store = VectorStore(pool)

    with pytest.raises(ValueError, match="tenant_id is required"):
        asyncio.run(store.hybrid_search("", "kick", [0.1], 5))

    assert pool.con.fetch_calls == []


def test_vectorstore_hybrid_search_applies_tenant_filter_to_dense_and_sparse_queries():
    pool = FakePool()
    store = VectorStore(pool)

    hits = asyncio.run(store.hybrid_search("tenant-a", "kick", [0.1, 0.2], 5, asset="Rig-7"))

    assert hits[0]["text"] == "Tenant-scoped text"
    assert pool.con.execute_calls[0] == (
        "SELECT set_config('petrobrain.tenant_id', $1, true)",
        ("tenant-a",),
    )
    assert len(pool.con.fetch_calls) == 2
    for query, params in pool.con.fetch_calls:
        assert "WHERE tenant_id = $1" in query
        # A9: asset filter accepts either the single ``asset`` value or the
        # ``assets`` list. The SQL uses ANY(...) so a leaf-scoped query can
        # also surface chunks filed at its parents.
        assert "asset = ANY($4::text[]) OR asset IS NULL" in query
        assert params[0] == "tenant-a"
        assert params[3] == ["Rig-7"]
        if "'dense'" in query:
            assert params[1] == "[0.1,0.2]"
        else:
            assert params[1] == "kick"


def test_doc_chunks_rls_migration_requires_session_tenant():
    migration = Path("app/db/migrations/001_doc_chunks_rls.sql").read_text(encoding="utf-8")

    assert "ALTER TABLE doc_chunks ENABLE ROW LEVEL SECURITY" in migration
    assert "ALTER TABLE doc_chunks FORCE ROW LEVEL SECURITY" in migration
    assert "CREATE POLICY tenant_isolation_doc_chunks" in migration
    assert "current_setting('petrobrain.tenant_id') = tenant_id" in migration
    assert "WITH CHECK (current_setting('petrobrain.tenant_id') = tenant_id)" in migration


def test_rls_context_blocks_buggy_cross_tenant_read_without_where_filter():
    con = FakeRLSConnection()

    asyncio.run(_set_tenant_context(con, "tenant-a"))
    rows = asyncio.run(con.fetch("SELECT id, tenant_id, text FROM doc_chunks"))

    assert rows == [{"id": 1, "tenant_id": "tenant-a", "text": "Tenant A SOP"}]
    assert all(row["tenant_id"] != "tenant-b" for row in rows)


def test_retriever_rejects_missing_tenant_before_embedding():
    embedder = FakeEmbedder()
    store = FakeSearchStore()
    retriever = Retriever(store, embedder=embedder, reranker=NoopReranker())

    with pytest.raises(ValueError, match="tenant_id is required"):
        asyncio.run(retriever.retrieve("kick response", tenant_id=""))

    assert embedder.calls == 0
    assert store.calls == []


def test_retriever_passes_tenant_to_store():
    embedder = FakeEmbedder()
    store = FakeSearchStore()
    retriever = Retriever(store, embedder=embedder, reranker=NoopReranker())

    hits = asyncio.run(retriever.retrieve("kick response", tenant_id="tenant-a", asset="Rig-7"))

    assert hits[0]["clause"] == "1"
    assert store.calls[0]["tenant_id"] == "tenant-a"
    assert store.calls[0]["asset"] == "Rig-7"
