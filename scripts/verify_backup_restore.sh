#!/usr/bin/env bash
# Backup + restore DRILL: prove the backup is restorable (a backup you have
# never restored is not a backup).
#
# Dumps the source DB, restores it into a scratch database, and compares row
# counts for the key tenant-scoped tables. Exits non-zero on any mismatch.
#
# Usage:
#   PB_DATABASE_URL=<source dsn> \
#   PB_SCRATCH_ADMIN_URL=<dsn to a server where we may CREATE/DROP DATABASE> \
#     ./scripts/verify_backup_restore.sh
#
# PB_SCRATCH_ADMIN_URL must point at a *throwaway* server (local docker or a CI
# Postgres service) - the script creates and drops a database on it.
set -euo pipefail

: "${PB_DATABASE_URL:?set PB_DATABASE_URL (source)}"
: "${PB_SCRATCH_ADMIN_URL:?set PB_SCRATCH_ADMIN_URL (throwaway server, admin DSN)}"

SRC="${PB_DATABASE_URL/postgresql+*:\/\//postgresql://}"
ADMIN="${PB_SCRATCH_ADMIN_URL/postgresql+*:\/\//postgresql://}"
SCRATCH_DB="pb_restore_drill_$(date -u +%s)"
WORK="$(mktemp -d)"
ARCHIVE="$WORK/drill.dump"

cleanup() {
  psql "$ADMIN" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\"" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

TABLES=(assets mrv_inventories tenant_memories user_settings org_settings report_schedules batch_jobs)

count_rows() {  # dsn -> prints "table count" lines for tables that exist
  local dsn="$1"
  for t in "${TABLES[@]}"; do
    local n
    n=$(psql "$dsn" -tAc "SELECT count(*) FROM $t" 2>/dev/null || echo "MISSING")
    echo "$t $n"
  done
}

echo "1/4 dumping source ..."
pg_dump --dbname="$SRC" --format=custom --no-owner --no-privileges --file="$ARCHIVE"

echo "2/4 creating scratch DB $SCRATCH_DB ..."
psql "$ADMIN" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$SCRATCH_DB\"" >/dev/null
TARGET="${ADMIN%/*}/$SCRATCH_DB"

echo "3/4 restoring into scratch ..."
pg_restore --dbname="$TARGET" --no-owner --no-privileges --jobs=4 "$ARCHIVE" >/dev/null 2>&1 || true

echo "4/4 comparing row counts ..."
SRC_COUNTS="$(count_rows "$SRC")"
DST_COUNTS="$(count_rows "$TARGET")"

if [ "$SRC_COUNTS" = "$DST_COUNTS" ]; then
  echo "PASS - restored row counts match the source:"
  echo "$SRC_COUNTS"
  exit 0
fi
echo "FAIL - row counts differ" >&2
diff <(echo "$SRC_COUNTS") <(echo "$DST_COUNTS") >&2 || true
exit 1
