# Handoff: Option A — off-host immutable audit copy + write-failure alarm

Status: **TODO** (approved by the operator). This is the durable-integrity half of
audit-log monitoring. The alerting half shipped in PR #10
(`audit_security_event` -> CloudWatch metric filter -> SNS).

## Why
The durable `audit_events` table (`app/db/audit_events_repository.py`) is
append-only + `REVOKE UPDATE/DELETE` (migration 002) but is **not hash-chained**;
the hash chain only exists in the ephemeral file log (`app/core/audit.py`). So a
scheduled "chain verify" has no durable target. Option A instead ships an
**independent, immutable copy of every audit row off-host to CloudWatch Logs**
(the approach `app/core/audit.py`'s own docstring names as the Phase-2 fix), and
alarms if audit **writes start failing** ("actions happening without being
recorded"). Audit rows are hash-only (request_hash/response_hash + metadata, no
raw user text — enforced by the module contract), so shipping them off-host is safe.

## Scope (two parts)

### Part 1 — off-host immutable audit copy
- **Settings** (`app/config.py`): add
  - `audit_cloudwatch_enabled: bool = False` (default off — dev/tests/demo unaffected)
  - `audit_cloudwatch_log_group: str = ""`
  - `audit_cloudwatch_region: str = ""` (falls back to `sovereign_region`)
- **Sink** (`app/core/audit_sink.py`, new): `emit_audit_row(record: dict) -> None`.
  When enabled, best-effort `boto3` `logs:PutLogEvents` into the dedicated group
  (create the log stream lazily; cache the sequence token). MUST be best-effort:
  never raise into the request path. On failure, emit the `audit_write_failed`
  marker (see Part 2). boto3 is already a dependency (S3).
- **Wire it**: call `emit_audit_row(row.as_dict())` from BOTH `append()` backends
  in `audit_events_repository.py` (next to the existing `_emit_security_signal`),
  and optionally from `AuditLogger.write` in `app/core/audit.py`.
- **Infra**:
  - `infra/modules/observability/main.tf`: add a dedicated
    `aws_cloudwatch_log_group "audit"` named `/petrobrain/${var.name}/audit` with
    long retention (e.g. `retention_in_days = 400`); output `audit_log_group`.
  - `infra/modules/compute`: grant the task role `logs:CreateLogStream` +
    `logs:PutLogEvents` on the audit group ARN only.
  - `infra/modules/stack/main.tf` `app_environment`: set
    `PB_AUDIT_CLOUDWATCH_ENABLED=true`, `PB_AUDIT_CLOUDWATCH_LOG_GROUP=<group>`,
    `PB_AUDIT_CLOUDWATCH_REGION=var.region`. (Render demo stays off.)

### Part 2 — audit-write-failure alarm
- **App**: when a durable audit append raises (DB down / permission denied) or the
  CloudWatch sink fails, emit `logger.error("audit_write_failed ...")` to stdout
  (hashes/ids only). Put the marker where it can't be missed — wrap the append in
  `routes_chat.py` / the auth audit calls, or a thin wrapper in the repo.
- **Infra** (`infra/modules/alerting/main.tf`): add a metric filter on
  `audit_write_failed` + an alarm -> `local.actions` (the SNS topic), mirroring the
  existing `audit_security_event` filter/alarm (copy that block).

## Acceptance / verification
- `app/core/audit_sink.py` unit tests: enabled -> calls `put_log_events` (mock the
  boto3 client); disabled -> no-op; client error -> emits `audit_write_failed`,
  does NOT raise.
- `.venv/Scripts/ruff check .` clean; `mypy app/` clean; `pytest tests/ -q` green
  (keep coverage >= 70; CI gate).
- `terraform fmt -check -recursive infra` clean; `terraform -chdir=infra/envs/prod
  validate` and `.../dev validate` Success.
- Demo unaffected (flag default off; `/health` still `environment:demo`).

## Workflow notes (important — match what the last session did)
- Repo root (nested): `c:/Users/Admin/Desktop/Petrobrain/PetroBrain`.
- Remote moved to **`Trust-Code-System/PetroBrain`** (origin still says `Idansss`;
  pushes redirect). Open/merge PRs against `Trust-Code-System/PetroBrain`.
- **Branch off `main`; stage ONLY your feature files.** The operator has
  uncommitted WIP under `app/api/routes_admin_documents.py`,
  `app/db/admin_document_repository.py`, `app/rag/vectorstore.py`,
  `app/workers/ingest_worker.py`, `frontend/apps/web/app/admin/documents/*`,
  `frontend/apps/web/lib/admin-documents/api.ts`, `tests/test_admin_document_upload.py`,
  and untracked `app/workers/ingest_failures.py` / `tests/test_ingest_failures.py` /
  `docs/TRACK_A_SETTINGS_SPEC.md`. **Never stage those.**
- `terraform` isn't on PATH; download 1.9.8 (the version CI uses) to verify fmt+validate.
- Wait for **all CI checks green** on the PR, then `gh pr merge <n> --merge --delete-branch`.
- Two Neon projects exist — see the `neon-projects` memory; not relevant to this task.

## Pointers
- Alerting module (extend it): `infra/modules/alerting/main.tf` — the
  `audit_security_event` filter+alarm there is the exact pattern to copy for
  `audit_write_failed`; the SNS topic is `local.actions`.
- Durable audit: `app/db/audit_events_repository.py` (both `append()` backends,
  `_emit_security_signal`). File audit + chain: `app/core/audit.py`.
- Audit schema (append-only, no chain): `app/db/migrations/002_audit_events.sql`.
