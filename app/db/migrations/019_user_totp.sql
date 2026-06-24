-- Two-factor auth (TOTP) on the users table from migration 004.
--
-- A user enrols an authenticator app: totp_secret holds their base32 secret,
-- totp_enabled flips true once they prove a code, totp_recovery_codes holds the
-- bcrypt hashes of their one-time backup codes (never the plaintext), and
-- totp_enrolled_utc records when enrollment completed. Existing rows default to
-- not-enrolled; whether they are *forced* to enrol is the PB_REQUIRE_2FA app
-- flag, not a column, so rollout can be toggled without a migration.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS totp_secret         TEXT,
    ADD COLUMN IF NOT EXISTS totp_enabled        BOOLEAN     NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS totp_recovery_codes JSONB       NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS totp_enrolled_utc   TIMESTAMPTZ;
