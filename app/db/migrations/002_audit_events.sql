-- Immutable audit log of platform activity.
--
-- The table stores HASHES of the request and response payloads (and the
-- retrieved-clause list, flags, and LLM usage) - never the raw text. This
-- keeps PII and prompts out of the audit store while still providing
-- chain-of-custody for safety reviews and red-team forensics.
--
-- Tenant isolation is enforced both via the WHERE clause in application
-- code AND via Postgres row-level security; both must pass.

CREATE TABLE IF NOT EXISTS audit_events (
    id                 BIGSERIAL PRIMARY KEY,
    ts                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant_id          TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    role               TEXT NOT NULL,
    action             TEXT NOT NULL,             -- "chat", "tool:build_kill_sheet", ...
    module             TEXT NOT NULL,             -- "general" | "well_control" | "emissions_mrv" | ...
    request_hash       TEXT NOT NULL,             -- sha256 hex of canonical-JSON request
    response_hash      TEXT NOT NULL,             -- sha256 hex of canonical-JSON response (or "" on error)
    retrieved_clauses  JSONB NOT NULL DEFAULT '[]'::jsonb,
    flags              JSONB NOT NULL DEFAULT '[]'::jsonb,
    usage              JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_ts
    ON audit_events (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_user_ts
    ON audit_events (tenant_id, user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_module_ts
    ON audit_events (tenant_id, module, ts DESC);

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_audit_events ON audit_events;

CREATE POLICY tenant_isolation_audit_events
ON audit_events
FOR ALL
USING (current_setting('petrobrain.tenant_id') = tenant_id)
WITH CHECK (current_setting('petrobrain.tenant_id') = tenant_id);

-- Make rows append-only at the database layer too. The application code
-- never issues UPDATE/DELETE - block it here as defence in depth.
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
