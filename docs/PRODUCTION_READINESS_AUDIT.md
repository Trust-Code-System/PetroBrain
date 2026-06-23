# PetroBrain - Production Readiness Audit

Date: 2026-06-23
Auditor: senior full-stack / DevOps / security review
Method: static inspection + live tool runs (ruff, mypy, pytest, pnpm typecheck, pnpm audit, git history scan)

---

## Remediation update - 2026-06-23 (PR Trust-Code-System/PetroBrain#6)

Score revised **84 -> 93 / 100** after remediation. Fixed and verified in branch
`chore/production-readiness-fixes`:

- **C1** `next` 14.2.13 -> 14.2.35 (DoS CVE patched). **H4** `happy-dom` -> 15.11.7.
  **M3** `esbuild` override -> 0.28.1.
- **H1** Security headers added to web+admin: static headers via `next.config.mjs`
  + **nonce-based CSP middleware** (`script-src` now drops `'unsafe-inline'`).
- **H2** API container runs as non-root (uid 10001).
- **H3** CI now runs frontend `lint` (blocking) + `pnpm audit` (informational);
  new `dast-and-quality.yml` (Lighthouse/pa11y/ZAP, manual+weekly) + `.zap/rules.tsv`.
- **M1** coverage floor `--cov-fail-under=70` (measured baseline 75%).
- **L1/L2** `app/robots.ts` + richer metadata/viewport. **L4** stray logs removed.

**Correction to original finding M4:** the backup/restore strategy IS documented -
`docs/BACKUP_RESTORE.md` (RPO/RTO targets, quarterly PITR drill, S3 version restore)
backed by real Terraform in `infra/modules/data/main.tf` (RDS `backup_retention_period`,
`storage_encrypted`, `multi_az`, `deletion_protection`, final snapshot; S3 versioning
Enabled). The only open item is running the **first** restore drill and filling the log.
Mercari "Backup / DR" is therefore PASS, not PARTIAL. The original M4 was an auditor miss.

**Still open (require human / ops, not code):** C2 (confirm prod targets the
Terraform/ECS stack with `PB_ENVIRONMENT=prod`, not the demo `render.yaml`), C3
(rotate the live Anthropic + Tavily keys), M2 (refresh-token flow, Phase-2), first
DR drill, and confirming the OTLP collector + alerts are wired.

---

## Overall score: 84 / 100 (original assessment; see remediation update above for current 93)

This is a high-maturity codebase. It already does most of what a launch audit asks
for: a fail-fast production config validator, real auth hardening (lockout, jti
revocation, no user enumeration, bcrypt with the 72-byte guard, 1h token TTL),
RBAC + tenant isolation + Postgres RLS, Redis-backed rate limiting, a strict CSP +
HSTS on the API, a CORS allowlist with validation, and a CI gate that runs ruff,
mypy, pytest+coverage, pip-audit, bandit, a red-team safety eval, and terraform
validate.

The points lost are concentrated in: (1) a known Next.js CVE in the pinned version,
(2) the production frontend origin shipping no security headers, (3) container runs
as root, (4) the CI gate not covering frontend lint / frontend dep audit / DAST /
Lighthouse / a11y, and (5) confirming the real production deploy path (Terraform/ECS)
versus the demo-only `render.yaml`.

### Live check results

| Check | Tool | Result |
|---|---|---|
| Backend lint | ruff 0.15.15 | PASS (all checks passed) |
| Backend types | mypy 2.1.0 | PASS (0 issues, 126 files) |
| Backend tests | pytest | 511 passed, 66 skipped (Postgres integration tests skip without DB) |
| Frontend types | tsc (6 pkgs) | PASS |
| Frontend deps | pnpm audit | 1 critical (dev-only), 1 moderate (prod), + transitive moderates |
| Secrets in git history | git log -S | CLEAN (.env never committed; only placeholders present) |

---

## Stack detected

- **Backend:** FastAPI (Python 3.11/3.12), `app/` package, 126 modules, 24 route files.
  Uvicorn ASGI. Pydantic v2 settings (`PB_` env prefix). Async Postgres (asyncpg +
  psycopg), pgvector RAG, Redis, Celery workers, S3/MinIO object store, Anthropic +
  OpenAI SDKs (Tier A) with a self-hosted vLLM/TGI path (Tier B, air-gapped).
- **Frontend:** pnpm 10 monorepo, Next.js 14.2.13 (App Router), React 18, TypeScript 5.5,
  Tailwind. Three apps (`web`, `admin`, `field`) + three packages (`api`, `types`, `ui`).
  Vitest tests, Storybook.
- **Infra:** Terraform (`infra/`, dev+prod envs, af-south-1) for the AWS/ECS production
  path; `render.yaml` for a demo-only deploy; `docker-compose-prod.yml` for Tier-B on-prem.
- **Auth:** Local email+password JWT (HS256/RS256) + optional Neon Auth SSO (EdDSA via JWKS).
- **Payments:** none detected (no Stripe/PayPal/billing integration in scope).
- **Email:** Resend (transactional invites), off until `PB_RESEND_API_KEY` + verified domain.
- **External integrations:** Anthropic, OpenAI, Tavily (web search), Neon (DB + Auth),
  VIIRS/TROPOMI satellite providers (optional), Resend.

---

## CRITICAL BLOCKERS (fix before launch)

### C1. Next.js DoS CVE in the pinned production version
- **Where:** `frontend/apps/web/package.json`, `apps/admin`, `apps/field` -> `next@14.2.13`.
- **Finding:** GHSA-7m27-7ghc-44w9 (moderate) - DoS via Server Actions, fixed in 14.2.21.
  Pinned version is vulnerable. (This is the only *production* dependency CVE.)
- **Fix:**
  ```bash
  cd frontend
  pnpm -r up next@14.2.32   # latest patched 14.2.x line
  pnpm install
  pnpm -r build
  ```
- **Severity rationale:** production-facing, no workaround per advisory. Bump is low-risk
  (same minor line).

### C2. Confirm the real production deploy path - `render.yaml` is demo-only
- **Where:** `render.yaml` (header literally says "DEMO ONLY. NOT FOR CUSTOMER DATA").
- **Finding:** `render.yaml` sets `PB_ENVIRONMENT=demo` (skips the prod validator),
  in-memory object store, ephemeral audit log, self-signup ON, shared `demo` tenant.
  If anyone points a customer at this URL it is unsafe. The intended prod path is
  `infra/envs/prod` (Terraform/ECS). **Blocker = decide and document which one launches,
  and ensure the launch target runs with `PB_ENVIRONMENT=prod`** so
  `validate_production_settings()` actually fires.
- **Fix:** Gate the demo. Add a banner (already wired via `/health` `demo:true`) and make
  sure DNS for the customer domain points at the ECS service, not the Render demo.

### C3. Rotate the live API keys sitting in the local `.env`
- **Where:** `PetroBrain/.env` (correctly gitignored, never committed - verified).
- **Finding:** The file on disk holds a **real** `ANTHROPIC_API_KEY` (`sk-ant-...`) and a
  real `PB_TAVILY_API_KEY` (`tvly-...`). They are not in git, but they are in plaintext on
  a developer workstation and were likely shared during development.
- **Fix:** Rotate both keys before launch; inject prod keys only via the platform secret
  store (Render dashboard `sync:false` / ECS task secrets / SSM). Never reuse the dev key
  in prod.

---

## HIGH PRIORITY

### H1. Production frontend origin ships no security headers
- **Where:** `frontend/apps/web/next.config.mjs` (and admin/field) - no `headers()` block.
- **Finding:** The FastAPI API sets a strict CSP, HSTS, X-Frame-Options, etc. on API
  responses, but the Next.js apps that serve the actual HTML/JS to the browser set
  **none**. A scanner hitting the frontend origin (web-check / ZAP) flags missing
  CSP/HSTS/X-Frame-Options/Referrer-Policy. Hosting on Vercel does not add these by default.
- **Fix (`next.config.mjs`):**
  ```js
  const securityHeaders = [
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    // Mirror the API CSP; Next needs 'unsafe-inline' for its inline bootstrap unless you adopt nonces.
    { key: 'Content-Security-Policy', value:
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://<your-api-domain>; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
  ];
  const nextConfig = {
    /* ...existing... */
    async headers() {
      return [{ source: '/:path*', headers: securityHeaders }];
    },
  };
  ```

### H2. Container runs as root
- **Where:** `Dockerfile` - no `USER` directive.
- **Finding:** The image runs uvicorn as root. A container escape or RCE then has root.
- **Fix (`Dockerfile`):**
  ```dockerfile
  RUN useradd --create-home --uid 10001 appuser
  # ...COPY app...
  RUN mkdir -p /var/cache/petrobrain && chown -R appuser /var/cache/petrobrain /srv
  USER appuser
  ```
  Verify `PB_RERANK_CACHE_DIR` and `/tmp` audit path are writable by the new uid.

### H3. CI does not lint the frontend, audit frontend deps, or run DAST/Lighthouse/a11y
- **Where:** `.github/workflows/ci.yml` frontend job runs typecheck + test + build only.
- **Finding:** `pnpm -r lint` (next lint / eslint) is configured per-app but never run in CI;
  `pnpm audit` is not run, so the Next.js CVE above went uncaught. No Lighthouse, pa11y, or
  ZAP coverage at all.
- **Fix:** add the steps in the "GitHub Actions" section below.

### H4. happy-dom critical CVE (test dependency)
- **Where:** `frontend/apps/web` devDependency `happy-dom@15.7.4`.
- **Finding:** GHSA-96g7-g7g9-jxw8 (critical) - server-side code execution via `<script>`,
  fixed in 15.10.2. **Dev/test only** (vitest DOM) - not in the production bundle - so it is
  HIGH not CRITICAL, but it runs your test code's DOM and should be bumped.
- **Fix:** `pnpm --filter @petrobrain/web up happy-dom@^15.11.0` (or migrate to jsdom).

---

## MEDIUM PRIORITY

- **M1. Coverage threshold not enforced.** `ci.yml` deliberately omits `--cov-fail-under`.
  Baseline it now and set a floor (e.g. `--cov-fail-under=70`) so coverage cannot silently rot.
- **M2. No refresh-token flow.** `jwt_ttl_hours=1`; on expiry the user must fully re-auth
  (acknowledged in `config.py`). Acceptable for launch but is a UX cliff for long field
  sessions - schedule the refresh flow.
- **M3. esbuild moderate CVE (dev-server CORS), transitive via Storybook.** Dev-only; bump
  Storybook or pin esbuild >=0.25 in a pnpm `overrides` block.
- **M4. Backup/restore strategy is implied, not documented.** Persistence is Neon/RDS
  Postgres (managed PITR) + S3 (versioning?). Write a one-page runbook: RPO/RTO, how to
  restore, S3 bucket versioning + lifecycle, and a tested restore drill.
- **M5. Rate limiter falls open if Redis is unreachable** (`_RedisBackend.over_limit`
  returns False on error). Reasonable availability trade-off, but document it and ensure the
  edge/WAF has an independent limit as defence in depth.
- **M6. Audit log on demo writes to `/tmp` (ephemeral).** Fine for demo; the prod path must
  use Postgres-backed audit (`PB_PERSISTENCE_BACKEND=postgres`) - already enforced by the
  validator. Just confirm at launch.

---

## LOW PRIORITY / IMPROVEMENTS

- **L1. SEO assets absent:** no `robots.txt`, `sitemap.xml`, `favicon.ico`, `manifest`, or
  Open Graph tags. Low impact - this is an auth-gated internal tool, not a public site - but
  add at least a favicon, a `robots.txt` that disallows crawling of the app, and OG tags on
  the signin landing page. Use Next's `app/robots.ts` and `app/icon.png` conventions.
- **L2. Metadata is minimal** (`app/layout.tsx` has title + description only). Add
  `metadataBase`, `openGraph`, and `themeColor`.
- **L3. No `pnpm lint` parity locally documented** - add `pnpm -r lint` to the README dev loop.
- **L4. `uvicorn.err.log` / `uvicorn.out.log` (154 KB) are committed-adjacent runtime logs**
  in the repo root. Gitignored by pattern, but delete the stragglers to keep the tree clean.

---

## Gap summary by category

### Security gaps
- Frontend origin has no security headers (H1).
- Container runs as root (H2).
- Next.js prod CVE (C1), happy-dom dev CVE (H4), esbuild dev CVE (M3).
- Live keys on disk need rotation (C3).
- **Strengths:** CSP without `unsafe-inline` for scripts, HSTS, CORS validation, RBAC +
  tenant RLS, auth lockout, jti revocation, no user enumeration, malware-scan hooks,
  metrics auth, bandit + pip-audit in CI, Tier-B air-gap SDK guard.

### Performance gaps
- No Lighthouse CI budget; no bundle-size gate. Add Lighthouse CI against a preview deploy.
- Reranker is RAM-heavy and disabled on small instances (expected); size prod instances for it.
- **Strengths:** Next font `display: swap`, React Query caching, image domains controlled.

### SEO gaps
- No robots/sitemap/favicon/OG/manifest (L1/L2). Low impact for an internal app.

### Accessibility gaps
- No automated a11y gate (pa11y/axe). The app is auth-gated so pa11y-ci needs an authed
  session or a public route allowlist. Add axe-core to the existing Vitest/RTL tests for
  component-level coverage now; add pa11y-ci against signin/landing routes in CI.

### Backend / API gaps
- Strong. Input validation via Pydantic validators (see `routes_auth.py`), consistent 401/403,
  no stack-trace leakage (FastAPI default, debug off), structured audit logging, OTel +
  Prometheus. Gap: enforce coverage floor (M1); add contract tests for the OpenAPI the
  frontend `@petrobrain/api` package generates.

### Database gaps
- Postgres RLS enforced and tested (`test_users_postgres.py`, `test_rls_policy_blocks_cross_tenant_reads`);
  startup refuses a role that bypasses RLS (`assert_role_safe_for_rls`). Gap: documented,
  drilled backup/restore (M4).

### Deployment gaps
- Decide demo vs prod target (C2). Container hardening (H2). Otherwise Terraform dev+prod
  validate in CI, Docker multi-profile (Tier A / Tier B) build, health check wired.

### Monitoring / logging gaps
- OTel traces, Prometheus `/metrics` (token-auth'd in prod), structlog JSON, audit trail -
  all present. Gap: confirm an external collector/alerting target is wired (OTLP endpoint +
  dashboards + on-call alerts), not just exposed.

---

## Exact files needing changes

| File | Change |
|---|---|
| `frontend/apps/web/package.json` (+admin, +field) | bump `next` to 14.2.32, `happy-dom` to ^15.11 |
| `frontend/apps/web/next.config.mjs` (+admin, +field) | add `headers()` security headers (H1) |
| `Dockerfile` | add non-root `USER` (H2) |
| `.github/workflows/ci.yml` | add frontend lint + `pnpm audit` + Lighthouse + pa11y + ZAP (H3) |
| `frontend/apps/web/app/layout.tsx` | richer metadata + OG (L2) |
| `frontend/apps/web/app/robots.ts`, `app/icon.png` | add (L1) |
| `docs/BACKUP_RESTORE.md` | new runbook (M4) |

---

## Commands to run

```bash
# 1. Patch frontend CVEs
cd frontend
pnpm -r up next@14.2.32
pnpm --filter @petrobrain/web up happy-dom@^15.11.0
pnpm install
pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test
pnpm audit --prod                      # should now be clean of prod findings

# 2. Re-verify backend locally
.venv/Scripts/ruff check .
.venv/Scripts/python -m mypy app/
.venv/Scripts/python -m pytest tests/ -q
pip install pip-audit bandit
pip-audit -r requirements.txt --ignore-vuln CVE-2025-64512 --ignore-vuln CVE-2025-70559
bandit -r app --severity-level high

# 3. Rotate keys (then set them in the platform secret store, not .env)

# 4. Lighthouse + a11y against a running preview (after build)
npx @lhci/cli autorun --collect.url=https://<preview-url>/signin
npx pa11y-ci --sitemap https://<preview-url>/sitemap.xml   # or explicit URL list
```

---

## GitHub Actions: suggested additions to `ci.yml`

Add to the existing **frontend** job (after build):
```yaml
      - name: Lint
        run: pnpm -r lint
      - name: Audit (prod deps, high+)
        run: pnpm audit --prod --audit-level high
```

New **lighthouse** job (runs against a built preview; gate on budgets, don't block on flaky perf):
```yaml
  lighthouse:
    runs-on: ubuntu-latest
    needs: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm install -g @lhci/cli
      - run: lhci autorun
        env:
          LHCI_GITHUB_APP_TOKEN: ${{ secrets.LHCI_GITHUB_APP_TOKEN }}
        continue-on-error: true   # informational until budgets are baselined
```

New **a11y** job (pa11y-ci against signin/public routes):
```yaml
  a11y:
    runs-on: ubuntu-latest
    needs: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm install -g pa11y-ci
      - run: pa11y-ci   # configure .pa11yci with the signin + landing URLs
        continue-on-error: true
```

New **ZAP baseline** job - **only against a deployed staging URL, never localhost, and never
on PRs from forks** (it is a live DAST scan):
```yaml
  zap-baseline:
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch'   # manual / scheduled, not every PR
    steps:
      - name: ZAP Baseline Scan
        uses: zaproxy/action-baseline@v0.12.0
        with:
          target: ${{ secrets.STAGING_URL }}
          rules_file_name: .zap/rules.tsv
          allow_issue_writing: true
```

---

## Mercari production-readiness checklist comparison

| Mercari area | Status | Notes |
|---|---|---|
| Code review / CI gates | PASS | ruff, mypy, pytest, pip-audit, bandit, safety eval, terraform - all merge-blocking |
| Test coverage | PARTIAL | 577 tests; no enforced floor (M1) |
| Dependency management | PARTIAL | pip-audit in CI; frontend audit missing (H3); 1 prod CVE (C1) |
| Secrets management | PARTIAL | gitignored, validator blocks dev defaults; live keys to rotate (C3) |
| Config / env validation | PASS | `validate_production_settings()` fails fast on unsafe prod config |
| AuthN / AuthZ | PASS | JWT + SSO, RBAC, tenant RLS, lockout, revocation |
| Rate limiting / abuse | PASS | Redis-backed, per-route, IP+principal keyed |
| Observability (logs/metrics/traces) | PASS | structlog, Prometheus, OTel; confirm collector wired |
| Alerting / on-call | UNKNOWN | metrics exposed; confirm dashboards + alerts + runbook |
| Graceful degradation | PASS | rate-limiter and Redis fall open; Tavily/email degrade cleanly |
| Backup / DR | PARTIAL | managed Postgres/S3 assumed; needs documented + drilled runbook (M4) |
| Capacity / scaling | PARTIAL | ECS path exists; reranker RAM sizing to confirm |
| Deployment / rollback | PARTIAL | Terraform + Docker; confirm rollback procedure documented |
| Security headers (frontend) | FAIL | none on Next.js origin (H1) |
| Container hardening | FAIL | runs as root (H2) |
| Health checks | PASS | `/health` wired, used by Render/ECS |

---

## Tool feasibility notes (per the brief)

- **Lissy93/web-check:** scans a *live URL*; can't meaningfully run against this local repo.
  Run it (or the hosted instance) against the deployed staging origin after H1 is fixed - it
  will confirm the new security headers and TLS posture.
- **lighthouse-ci:** feasible; needs a built/running preview URL. App is auth-gated, so point
  it at `/signin` (public) for perf/SEO/a11y of the entry point; add authed routes via an LHCI
  Puppeteer login script later. Added as an (informational-first) CI job above.
- **OWASP ZAP baseline:** feasible **only** as a manual/scheduled job against staging, not on
  every PR and not against localhost. Workflow provided above. Safe to add this way.
- **pa11y-ci:** feasible against public routes now; authed routes need a session script.
  Component-level axe-core in the existing Vitest suite is the fastest first win.
- **snyk/cli:** not run (needs a `SNYK_TOKEN`). Equivalent coverage was achieved with
  `pip-audit` (already in CI) + `pnpm audit` (run manually here). Add `snyk test` later if you
  want license + transitive-fix advice; it is not a blocker.

---

## Final launch checklist

- [ ] Bump `next` to 14.2.32 and `happy-dom` to ^15.11; `pnpm audit --prod` clean (C1, H4)
- [ ] Rotate the Anthropic + Tavily keys; inject prod secrets via the platform store only (C3)
- [ ] Confirm the launch target is the prod ECS/Terraform stack with `PB_ENVIRONMENT=prod`
      (so the validator runs), not the demo `render.yaml` (C2)
- [ ] Add security headers to all three Next.js apps (H1)
- [ ] Add non-root `USER` to the Dockerfile and verify writable paths (H2)
- [ ] Add frontend lint + `pnpm audit` to CI; add Lighthouse/pa11y/ZAP jobs (H3)
- [ ] Set a coverage floor in CI (M1)
- [ ] Write and drill the backup/restore runbook; enable S3 versioning (M4)
- [ ] Confirm OTLP collector + dashboards + alerts + on-call are live (monitoring)
- [ ] Set `PB_ENABLE_SELF_SIGNUP=false`, real `PB_CORS_ALLOW_ORIGINS`, `PB_METRICS_AUTH_TOKEN`,
      `rediss://` URLs, malware scanning on + fail-closed (all enforced by the validator - just
      provide the values)
- [ ] Verify `PB_RESEND_API_KEY` + verified sender domain if invites must email
- [ ] Add favicon + robots.txt + richer metadata (L1, L2)
- [ ] Run web-check + ZAP baseline against staging; resolve any new findings

---

## Addendum - 2026-06-23 (follow-up pass)

This addendum supplements the report above after a user-reported incident: a raw
`embed: Error code: 429 - {'error': {'message': 'You exceeded your current quota,
please check your plan and billing details...'}}` was visible to a user. It also
corrects two items in the original pass.

## NEW CRITICAL - C4. Provider error text leaked to users (FIXED this pass)

This **contradicts** the "Backend / API gaps" line above that read "no stack-trace
leakage." That claim held for chat (`routes_chat.py` streams a generic error) but
NOT for document ingestion.

- **Where:** `app/workers/ingest_worker.py` stored `failure_reason=f"embed: {exc}"`
  - the entire OpenAI exception body - which `routes_admin_documents.py::_to_status`
  returned and `DocumentsTable.tsx:90` rendered. Result: PetroBrain's billing state,
  quota status, and provider identity were shown to a tenant admin.
- **Fix applied:**
  - NEW `app/workers/ingest_failures.py::safe_failure_reason(stage, exc)` - maps any
    exception to a short, non-sensitive `"<stage>: ..."` message.
  - `ingest_worker.py` (extract + embed) and `routes_admin_documents.py` (dispatch)
    now log the full exception server-side and persist only the sanitized reason.
  - NEW `tests/test_ingest_failures.py` asserts the exact 429 body never leaks.
  - Verified: `pytest tests/test_ingest_failures.py tests/test_admin_document_upload.py
    tests/test_admin_documents_postgres.py` -> 28 passed, 6 skipped; `ruff check` clean.
- **Hardening guideline:** never persist or return `str(exc)` from a third-party SDK
  to a client. Treat provider/parsing error bodies as server-log-only.

## Correction - frontend dependency audit (full tree vs `--prod`)

The original pass ran `pnpm audit --prod` and reported ~1 critical / 1 moderate. A
full `pnpm audit` on the current lockfile (modified 2026-06-22) reports a very
different picture:

- **123 advisories total: 7 critical, 47 high, 56 moderate, 13 low.**

Both are "correct" for their scope. The gap is dev/build tooling not shipped to
users (storybook, expo-router, eslint chains, vite/vitest, sucrase, rollup, ajv,
lodash-in-jest-dom, tar, glob CLI). The production-runtime-exposed item that matters
most remains **Next.js 14.2.13** (DoS CVEs; fix >=14.2.35), already tracked as C1/H4.

Recommendation: gate BOTH in CI so neither view hides the other:

```yaml
      - name: Frontend dep audit (prod, blocking)
        run: pnpm audit --prod --audit-level high
      - name: Frontend dep audit (full tree, report-only)
        run: pnpm audit --audit-level high || true
```

And add Renovate/Dependabot so the dev-tooling tree stops drifting (it is how 47
high advisories accumulated unnoticed).

## Net effect on score

The leak is a real user-facing data-disclosure bug the first pass missed, but it is
now fixed and tested. The fuller dependency picture is worse than `--prod` suggested.
Adjusted overall readiness for "onboard a real customer onto the live (demo) deploy
today": **~70/100** - unchanged thesis (strong foundation, not launch-ready as
deployed), with C4 added to and now cleared from the blocker list.
