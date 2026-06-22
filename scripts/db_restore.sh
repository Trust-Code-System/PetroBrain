#!/usr/bin/env bash
# Restore a PetroBrain pg_dump archive into a target database.
#
# Usage:
#   PB_RESTORE_TARGET_URL=postgresql://user:pass@host:5432/db \
#     ./scripts/db_restore.sh backups/petrobrain-YYYYMMDDTHHMMSSZ.dump
#
# DANGER: --clean drops existing objects before recreating them. Point
# PB_RESTORE_TARGET_URL at the RESTORE target (a fresh DB or a recovery branch),
# never at the live primary unless you are deliberately rolling back.
set -euo pipefail

: "${PB_RESTORE_TARGET_URL:?set PB_RESTORE_TARGET_URL to the restore target DSN}"
ARCHIVE="${1:?pass the .dump archive to restore}"
[ -f "$ARCHIVE" ] || { echo "archive not found: $ARCHIVE" >&2; exit 1; }

DSN="${PB_RESTORE_TARGET_URL/postgresql+*:\/\//postgresql://}"

echo "Restoring $ARCHIVE -> $DSN"
# pgvector extension must exist before tables that reference it; pg_restore
# replays the CREATE EXTENSION from the dump, so a clean target only needs the
# 'vector' extension to be installable (Neon/pgvector images ship it).
pg_restore --dbname="$DSN" --clean --if-exists --no-owner --no-privileges \
  --jobs=4 "$ARCHIVE"
echo "Restore complete."
