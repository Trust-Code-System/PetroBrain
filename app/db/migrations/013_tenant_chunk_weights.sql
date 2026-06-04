-- Tenant-scoped chunk weights for retrieval re-ranking (slice 3 of the
-- learning loop).
--
-- One row per (tenant, chunk) tracks how many 👍 / 👎 the tenant's users
-- have left on turns that cited the chunk, plus a derived multiplicative
-- ``weight`` in [0.5, 1.5] that the retriever applies to fused scores
-- before rerank.
--
-- Hard floor of 0.5 is the load-bearing safety property: even a chunk that
-- has accumulated 100 thumbs-downs is only demoted by 50% - it still
-- surfaces in retrieval, the model still has a chance to cite it, and a
-- safety SOP cannot be hidden by user feedback alone. The "never auto-
-- weaken safety guardrails" rule from the production-readiness audit is
-- enforced numerically here, not just by convention.
--
-- Hard ceiling of 1.5 prevents an over-boosted chunk from monopolising the
-- prompt budget at the expense of other relevant context.

CREATE TABLE IF NOT EXISTS tenant_chunk_weights (
    tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    chunk_id     BIGINT NOT NULL,
    weight       DOUBLE PRECISION NOT NULL DEFAULT 1.0
                 CHECK (weight >= 0.5 AND weight <= 1.5),
    up_count     INTEGER NOT NULL DEFAULT 0,
    down_count   INTEGER NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_chunk_weights_tenant
    ON tenant_chunk_weights (tenant_id);

ALTER TABLE tenant_chunk_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_chunk_weights FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_chunk_weights ON tenant_chunk_weights;
CREATE POLICY tenant_isolation_chunk_weights
ON tenant_chunk_weights
FOR ALL
USING (
    current_setting('petrobrain.tenant_id') = '*'
    OR current_setting('petrobrain.tenant_id') = tenant_id
)
WITH CHECK (
    current_setting('petrobrain.tenant_id') = '*'
    OR current_setting('petrobrain.tenant_id') = tenant_id
);
