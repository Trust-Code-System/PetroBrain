-- Password-based local auth (signup/signin) on top of the invite-based users
-- table from migration 004. Existing invite-only flows keep working: rows
-- without a password_hash simply can't sign in via /auth/signin until they
-- complete signup or an admin sets one.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash    TEXT,
    ADD COLUMN IF NOT EXISTS password_set_utc TIMESTAMPTZ;

-- Lookup by (tenant, lowercase email) for signin. The UNIQUE(tenant_id, email)
-- constraint from 004 already enforces uniqueness; this index just makes the
-- case-insensitive lookup that /auth/signin performs cheap.
CREATE INDEX IF NOT EXISTS idx_users_tenant_email_lower
    ON users (tenant_id, lower(email));
