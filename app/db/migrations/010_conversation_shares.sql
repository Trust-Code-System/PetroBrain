-- Conversation shares (tenant-scoped read links).
-- A user mints a share by snapshotting the conversation client-side and
-- POSTing it here; the backend stores the JSON snapshot and returns an
-- opaque token. Viewers hit /share/{token}; the GET re-verifies that the
-- requester's principal.tenant_id matches the share's tenant_id before
-- handing back the snapshot. RLS is the backstop on top of that.
--
-- Snapshot-at-mint semantics: subsequent edits to the original (client-side)
-- conversation never propagate. Expires after 30 days unless extended;
-- owners revoke by setting revoked_utc.

CREATE TABLE IF NOT EXISTS conversation_shares (
    token            TEXT PRIMARY KEY,
    tenant_id        TEXT NOT NULL,
    created_by       TEXT NOT NULL,
    title            TEXT NOT NULL,
    snapshot         JSONB NOT NULL,
    created_utc      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_utc      TIMESTAMPTZ NOT NULL,
    revoked_utc      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_shares_tenant_created
    ON conversation_shares (tenant_id, created_utc DESC);
CREATE INDEX IF NOT EXISTS idx_shares_created_by
    ON conversation_shares (created_by, created_utc DESC);

ALTER TABLE conversation_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_shares FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_shares ON conversation_shares;
CREATE POLICY tenant_isolation_shares
ON conversation_shares
FOR ALL
USING (
    current_setting('petrobrain.tenant_id') = '*'
    OR current_setting('petrobrain.tenant_id') = tenant_id
)
WITH CHECK (
    current_setting('petrobrain.tenant_id') = '*'
    OR current_setting('petrobrain.tenant_id') = tenant_id
);
