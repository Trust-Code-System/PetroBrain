#!/usr/bin/env bash
# Neon disaster-recovery DRILL (point-in-time, non-destructive).
#
# Proves the live Neon database is recoverable: it branches the DB as it existed
# ~RESTORE_MINUTES ago (Neon's PITR), verifies the branch holds real, recent data
# by counting key tables, then deletes the branch. Your live data is never
# touched. A backup you have never restored is not a backup.
#
# This is the Neon equivalent of the RDS point-in-time drill in
# docs/BACKUP_RESTORE.md; run that one once the AWS/ECS prod stack is up.
#
# PREREQUISITES (the one part only you can do - it needs YOUR Neon account):
#   * Authenticate once:  npx neonctl auth      (opens your browser)
#       ...or export a key: export NEON_API_KEY=<key from Neon Console -> Account settings -> API keys>
#   * Node/npx available (used to run neonctl without a global install).
#
# USAGE:
#   bash scripts/dr_drill_neon.sh
#   # If you have more than one Neon project, set the id:
#   NEON_PROJECT_ID=<project-id> bash scripts/dr_drill_neon.sh
#
# Tunables (env): RESTORE_MINUTES (default 5), NEON_DATABASE (default neondb),
#                 DRILL_BRANCH (default dr-drill-<UTC date>).
set -euo pipefail

RESTORE_MINUTES="${RESTORE_MINUTES:-5}"
NEON_DATABASE="${NEON_DATABASE:-neondb}"
DRILL_BRANCH="${DRILL_BRANCH:-dr-drill-$(date -u +%Y%m%d-%H%M%S)}"
NEON="npx -y neonctl"

# Pick the project's venv python so we can verify with psycopg (no psql needed).
if [ -x ".venv/Scripts/python.exe" ]; then PY=".venv/Scripts/python.exe"
elif [ -x ".venv/bin/python" ]; then PY=".venv/bin/python"
else PY="python"; fi

note() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# --- resolve project ----------------------------------------------------------
PROJECT_ARG=()
if [ -n "${NEON_PROJECT_ID:-}" ]; then
  PROJECT_ARG=(--project-id "$NEON_PROJECT_ID")
else
  note "No NEON_PROJECT_ID set; listing projects (set it if there is more than one)"
  $NEON projects list || { echo "neonctl not authenticated. Run 'npx neonctl auth' or set NEON_API_KEY."; exit 1; }
fi

# --- 1. restore point ---------------------------------------------------------
RESTORE_TS="$(date -u -d "${RESTORE_MINUTES} minutes ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -v-"${RESTORE_MINUTES}"M +%Y-%m-%dT%H:%M:%SZ)"   # GNU or BSD date
note "Restore point (UTC): $RESTORE_TS  | drill branch: $DRILL_BRANCH"

DRILL_START=$(date +%s)

# --- 2. branch from that point in time (the "restore") ------------------------
note "Creating PITR branch..."
$NEON branches create "${PROJECT_ARG[@]}" --name "$DRILL_BRANCH" --parent-timestamp "$RESTORE_TS"

cleanup() {
  note "Tearing down drill branch..."
  $NEON branches delete "${PROJECT_ARG[@]}" "$DRILL_BRANCH" >/dev/null 2>&1 \
    || echo "WARN: could not delete branch '$DRILL_BRANCH' - delete it in the Neon Console."
}
trap cleanup EXIT

# --- 3. connection string for the restored branch -----------------------------
note "Fetching branch connection string..."
DSN="$($NEON connection-string "$DRILL_BRANCH" "${PROJECT_ARG[@]}" --database-name "$NEON_DATABASE")"

# --- 4. verify the restored data is real (row counts) -------------------------
note "Verifying restored data (psycopg)..."
"$PY" - "$DSN" <<'PY'
import sys, psycopg
dsn = sys.argv[1]
tables = ["tenants", "users", "assets", "mrv_inventories"]
with psycopg.connect(dsn, connect_timeout=20) as conn, conn.cursor() as cur:
    ok = False
    for t in tables:
        try:
            cur.execute(f"SELECT count(*) FROM {t}")
            n = cur.fetchone()[0]
            print(f"  {t:18} {n}")
            if t in ("tenants", "users") and n > 0:
                ok = True
        except Exception as exc:
            conn.rollback()
            print(f"  {t:18} (absent: {exc.__class__.__name__})")
    if not ok:
        sys.exit("VERIFY FAILED: no rows in tenants/users on the restored branch")
print("  VERIFY OK: restored branch holds tenant/user data")
PY

DRILL_END=$(date +%s)
RTO=$((DRILL_END - DRILL_START))

# --- 5. results (paste this row into docs/BACKUP_RESTORE.md) ------------------
note "DRILL PASSED"
echo "Measured RTO (create+verify): ${RTO}s   | RPO target: ~${RESTORE_MINUTES} min"
echo
echo "Log row for docs/BACKUP_RESTORE.md:"
echo "| $(date -u +%Y-%m-%d) | ${RTO}s (Neon branch) | ~${RESTORE_MINUTES} min | PASS | First Neon PITR drill; tenants/users restored and verified |"
