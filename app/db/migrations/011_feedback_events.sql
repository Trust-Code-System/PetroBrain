-- Per-turn feedback (thumbs up/down + optional reason) from the chat UI.
--
-- This is the data ingestion side of the learning loop. Writes are append-only
-- (no UPDATE/DELETE from the app); the admin console reads them for triage.
-- Strictly tenant-scoped: tenant A's feedback never affects tenant B's
-- retrieval, prompts, or behaviour. The system NEVER fine-tunes the LLM on
-- this data - it informs prompt-layer memory + retrieval re-ranking only,
-- which keeps the engineering-math determinism guarantee intact.
--
-- turn_id is minted server-side at the chat handler so the client doesn't get
-- to invent it (no client-supplied IDs land in the DB primary key space).

CREATE TABLE IF NOT EXISTS feedback_events (
    id           TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    user_id      TEXT NOT NULL,
    turn_id      TEXT NOT NULL,
    rating       TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    reason       TEXT,
    module       TEXT,
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_utc  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One feedback row per (tenant, user, turn) - the latest rating wins via
-- INSERT ... ON CONFLICT DO UPDATE on the repository side.
CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_tenant_user_turn
    ON feedback_events (tenant_id, user_id, turn_id);

CREATE INDEX IF NOT EXISTS idx_feedback_tenant_created
    ON feedback_events (tenant_id, created_utc DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_tenant_rating
    ON feedback_events (tenant_id, rating);

ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_feedback ON feedback_events;
CREATE POLICY tenant_isolation_feedback
ON feedback_events
FOR ALL
USING (
    current_setting('petrobrain.tenant_id') = '*'
    OR current_setting('petrobrain.tenant_id') = tenant_id
)
WITH CHECK (
    current_setting('petrobrain.tenant_id') = '*'
    OR current_setting('petrobrain.tenant_id') = tenant_id
);
