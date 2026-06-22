-- Account settings (Group 1: Profile / Settings / Org).
--
-- Two tables back the logged-in account area:
--   * user_settings  - per-user display name, avatar, and preferences
--                      (units / language / notification + opportunity alerts).
--   * org_settings   - per-tenant organization config the account "Org" tab edits
--                      (company / country / segment / reporting boundary / units /
--                       GWP set / selected reporting frameworks).
--
-- Both are tenant-isolated via row-level security on the petrobrain.tenant_id GUC,
-- same contract as assets/onboarding (see app/db/pg.py and migration 003/017).
-- The '*' branch lets a platform_admin connection (GUC set to '*') cross tenants;
-- every other connection is pinned to its own tenant_id.

CREATE TABLE IF NOT EXISTS user_settings (
    tenant_id          TEXT NOT NULL,
    user_id            TEXT NOT NULL,
    display_name       TEXT NOT NULL DEFAULT '',
    avatar_url         TEXT NULL,
    units              TEXT NOT NULL DEFAULT 'oilfield',
    language           TEXT NOT NULL DEFAULT 'en',
    notifications      JSONB NOT NULL DEFAULT '{"product": true, "reports": true, "alerts": true}'::jsonb,
    opportunity_alerts JSONB NULL,
    created_utc        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_utc        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_settings_tenant ON user_settings (tenant_id);

ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_user_settings ON user_settings;
CREATE POLICY tenant_isolation_user_settings ON user_settings
FOR ALL
USING (
    current_setting('petrobrain.tenant_id') = '*'
    OR current_setting('petrobrain.tenant_id') = tenant_id
)
WITH CHECK (
    current_setting('petrobrain.tenant_id') = '*'
    OR current_setting('petrobrain.tenant_id') = tenant_id
);


CREATE TABLE IF NOT EXISTS org_settings (
    tenant_id          TEXT PRIMARY KEY,
    company            TEXT NOT NULL DEFAULT '',
    country            TEXT NOT NULL DEFAULT '',
    segment            TEXT NOT NULL DEFAULT 'upstream',
    reporting_boundary TEXT NOT NULL DEFAULT 'operational_control',
    units              TEXT NOT NULL DEFAULT 'oilfield',
    gwp_set            TEXT NOT NULL DEFAULT 'ar6',
    frameworks         JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_utc        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_utc        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE org_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_org_settings ON org_settings;
CREATE POLICY tenant_isolation_org_settings ON org_settings
FOR ALL
USING (
    current_setting('petrobrain.tenant_id') = '*'
    OR current_setting('petrobrain.tenant_id') = tenant_id
)
WITH CHECK (
    current_setting('petrobrain.tenant_id') = '*'
    OR current_setting('petrobrain.tenant_id') = tenant_id
);
