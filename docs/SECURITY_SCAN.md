# Security scan baseline

Automated scans run in CI (`.github/workflows/ci.yml` → `security` job) on every PR and push
to `main`. Reproduce locally from `PetroBrain/`:

```bash
pip install pip-audit bandit
pip-audit -r requirements.txt
pip-audit -r requirements-tierb.txt
bandit -r app
```

Last run: 2026-06-22.

## Dependency audit — `pip-audit`

After the 2026-06-22 patch bumps (`pydantic-settings 2.14.2`, `cryptography 48.0.1`,
`python-multipart 0.0.31`), the only remaining finding is a transitive one:

| Package | Version | Advisory | Fixed in | Status |
|---|---|---|---|---|
| pdfminer-six | 20250506 | CVE-2025-64512 | 20251107 | Accepted / tracked |
| pdfminer-six | 20250506 | CVE-2025-70559 | 20251230 | Accepted / tracked |

`pdfminer-six` is pulled **transitively** by `pdfplumber==0.11.7` (PDF text extraction for
document ingestion). `pdfplumber` pins an incompatible `pdfminer.six` range, so it can't be
bumped in isolation without risking ingestion regressions.

- **Exposure:** both CVEs require parsing a hostile PDF. Uploads are authenticated,
  tenant-scoped, size-limited and validated at the proxy edge; ingestion is server-side and
  not reachable unauthenticated.
- **Remediation path (tracked follow-up):** bump `pdfplumber` to a release that allows
  `pdfminer.six>=20251230`, then drop the `--ignore-vuln` flags in the CI gate.

The CI gate runs `pip-audit ... --ignore-vuln CVE-2025-64512 --ignore-vuln CVE-2025-70559`, so
any **new** dependency CVE fails the build while this documented, accepted finding does not.

## Static analysis — `bandit` (against `app/`)

- **HIGH: 1 — false positive, suppressed.** `B613` (Trojan-Source bidirectional control
  characters) at `app/storage/object_store.py`. The flagged characters are an intentional
  **deny-set** (`_UNSAFE_FILENAME_CHARS`) that `object_key_for()` *strips* from uploaded
  filenames — defensive code against spoofed names reaching the audit log / S3 console.
  Suppressed inline with `# nosec B613` + justification. The CI gate runs `--severity-level
  high`, so the HIGH count is 0 after suppression.
- **MEDIUM: ~67 — false positives, not gated.** All `B608` ("possible SQL injection via
  string construction"). These are parameterized queries (psycopg binds `%s` params
  separately) that bandit's static check can't see through. Tenant SQL is parameterized and
  RLS-backstopped (`app/db/pg.py` + the migration policies). Gating at HIGH keeps the signal
  clean; a future pass can add targeted `# nosec B608` where worthwhile.

## Tenant isolation (Row-Level Security)

RLS is `ENABLE`d **and** `FORCE`d on every tenant-scoped table (`app/db/migrations/*.sql`),
keyed on the `petrobrain.tenant_id` GUC. `app/db/pg.py` sets the GUC per pooled connection
(and resets it on return), and `assert_role_safe_for_rls()` refuses to boot in production under
a SUPERUSER/BYPASSRLS role (which would silently bypass RLS even under FORCE).

`tests/test_rls_proof_postgres.py` proves this at the engine level, as the NOSUPERUSER app
role: a cross-tenant `SELECT` returns nothing, a cross-tenant `INSERT` is rejected by the
`WITH CHECK` policy, and an unset tenant GUC fails closed. It runs in CI against the Postgres
service (gated by `PB_TEST_DATABASE_URL`).
