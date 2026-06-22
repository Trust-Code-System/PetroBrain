#!/usr/bin/env bash
# Logical backup of the PetroBrain Postgres database.
#
# Usage:
#   PB_DATABASE_URL=postgresql://user:pass@host:5432/db ./scripts/db_backup.sh [out_dir]
#
# Produces a compressed pg_dump custom-format archive (-Fc) that pg_restore can
# replay selectively. Custom format is chosen over plain SQL so a restore can be
# parallelised (-j) and individual tables recovered.
#
# This is the portable, provider-independent backup. On Neon it COMPLEMENTS (does
# not replace) Neon's continuous WAL/PITR - see docs/BACKUP_RESTORE.md.
set -euo pipefail

: "${PB_DATABASE_URL:?set PB_DATABASE_URL to the source database DSN}"

OUT_DIR="${1:-backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="$OUT_DIR/petrobrain-${STAMP}.dump"

# Strip any SQLAlchemy-style +driver suffix libpq can't parse.
DSN="${PB_DATABASE_URL/postgresql+*:\/\//postgresql://}"

echo "Backing up -> $OUT_FILE"
pg_dump --dbname="$DSN" --format=custom --no-owner --no-privileges --file="$OUT_FILE"
echo "Done: $(du -h "$OUT_FILE" | cut -f1) $OUT_FILE"
