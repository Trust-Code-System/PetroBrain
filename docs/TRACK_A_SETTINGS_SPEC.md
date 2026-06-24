# Track A — Settings slice build spec

Self-contained spec to build the **Settings/Profile** backend (first Track A slice) end-to-end
against this repo (`Trust-Code-System/PetroBrain`, FastAPI). CI is currently **green** — keep it
green. The separate frontend repo is **PetroBrain Web** (Next.js, at
`C:\Users\Admin\Desktop\PetroBrain Web`), which consumes this backend through its `/api/pb/*`
proxy and reveals pages via `lib/featureFlags.ts`.

## The contract (from PetroBrain Web `lib/account/client.ts` + `types.ts`)

Build these exact backend paths (the frontend client is unchanged):

| Method + path | Returns / body | Shape (TS) |
|---|---|---|
| `GET /profile` | `ProfileData` | `{ id, name, email, role, org?, avatarUrl? }` |
| `PATCH /profile` | `ProfileData` | body `{ name }` |
| `POST /profile/avatar` (multipart `file`) | `ProfileData` | — |
| `GET /org` | `OrgSettings` | `{ company, country, segment, reportingBoundary, units, gwpSet, frameworks[], assetCount? }` |
| `PATCH /org` | `OrgSettings` | partial |
| `GET /settings` | `UserSettings` | `{ units, language, notifications{product,reports,alerts}, opportunityAlerts? }` |
| `PATCH /settings` | `UserSettings` | partial |
| `GET /team` | `{ items: TeamMember[] }` | `TeamMember{ id, name, email, role, status? }` |
| `GET /memory` | `{ items: CopilotMemory[] }` | `CopilotMemory{ id, content, kind?, createdAt? }` |
| `PATCH /memory/{id}` | `CopilotMemory` | body `{ content }` |
| `DELETE /memory/{id}` | 204 | — |

Enums: `units = oilfield|metric`, `language = en|pcm|yo|ha`, `gwpSet = ar5|ar6`,
`reportingBoundary = operational_control|financial_control|equity_share`,
`segment = upstream|midstream|downstream|integrated`.

## Data-model decisions (grounded in the existing schema)

- `users` (migration 004) has `email, role, status, allowed_assets` but **no `name`/`avatar`**.
- `tenants` has an `attributes` JSONB.
- `tenant_memories` (012) exists but is admin/tenant-scoped (`/admin/memory`).

So:
1. **New migration `app/db/migrations/018_account.sql`** — table `account_profiles`:
   `tenant_id TEXT, user_id TEXT, display_name TEXT, avatar_url TEXT,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb, created_utc, updated_utc,
    PRIMARY KEY (tenant_id, user_id)`. Add `ENABLE` + `FORCE ROW LEVEL SECURITY` and a
   `tenant_isolation_account_profiles` policy `USING/WITH CHECK
    (current_setting('petrobrain.tenant_id') = tenant_id)` — copy the exact form from
   `003_assets.sql`. (Migrations auto-apply via `pg.apply_migrations` globbing `*.sql`.)
2. **Profile** = join `users` (email, role) + `account_profiles` (display_name, avatar_url) +
   tenant name (org). Lazily create a default `account_profiles` row on first read.
   `name` defaults to the email local-part when `display_name` is null.
3. **Settings** = `account_profiles.settings` JSONB, merged over a default `UserSettings`.
   PATCH does a shallow merge + revalidate enums.
4. **Org** = read/write `tenants.attributes` (keys: company, country, segment,
   reportingBoundary, units, gwpSet, frameworks). `company` falls back to `tenants.name`.
   `assetCount` = `SELECT count(*) FROM assets` (tenant-scoped). **PATCH /org gated to
   `require_role("admin","tenant_owner","platform_admin")`.**
5. **Team** = `users` rows for the tenant → `TeamMember`. `name` from `account_profiles` if
   present, else email local-part. `status`: map `active`→active, `invited`→invited.
6. **Memory** = the signed-in user's own copilot memories. Reuse `tenant_memory_repository`
   filtered to `created_by == who.user_id`; map `body→content`, keep `kind`, `created_utc→createdAt`.
   PATCH runs `check_memory_body` (app.core.memory_guard) before saving; DELETE archives/removes.
7. **Avatar** = validate (reuse the `_scan_upload`/object-store pattern from
   `routes_admin_documents`), store via `app.storage.object_store.object_key_for` +
   `get_object_store()`, set `account_profiles.avatar_url`, return `ProfileData`. *(Avatar may
   ship as a follow-up commit if object-store wiring is heavy — the page degrades without it.)*

## Files to add/change (backend)

- `app/db/migrations/018_account.sql` — table + RLS (above).
- `app/db/account_repository.py` — `LocalJsonAccountRepository` + `PostgresAccountRepository`
  + `get_account_repository()` factory (mirror `research_repository.py` structure exactly,
  incl. the `builtins.list` annotation convention if you add a `list`-named method, and the
  tenant-scoped `pg.tenant_connection`). Methods: `get_profile`, `upsert_profile`,
  `get_settings`, `update_settings`.
- `app/api/routes_account.py` — `router = APIRouter(tags=["account"])` with the routes above,
  each `Depends(get_principal)`. (No prefix — paths are top-level `/profile`, `/org`, etc.)
- `app/models/schemas.py` — pydantic request/response models matching the TS shapes.
- `app/main.py` — `app.include_router(routes_account.router)` (find where the other routers
  are included and add it).
- Tests: `tests/test_account.py` (LocalJson + TestClient with `auth_helpers`, like
  `test_auth_me.py`) and `tests/test_account_postgres.py` (PG-gated, NOSUPERUSER role pattern
  from `test_assets_postgres.py`) — cover tenant isolation (a second tenant can't read/patch
  the first's profile/settings), the default-on-first-read, and the `/org` admin gate.

## Frontend reconciliation (PetroBrain Web)

- Paths already match (`/profile`, `/org`, `/settings`, `/team`, `/memory`) — **no client
  change needed** if you build the exact paths above. Verify `lib/account/client.ts`.
- **Reveal:** add `"/app/settings"` and `"/app/profile"` to `LIVE_APP_HREFS` in
  `lib/featureFlags.ts` (and update the reveal-on-ship comment). Build + the page goes live.

## Verification loop (must stay green — every step is merge-blocking)

```bash
# backend (from PetroBrain/)
python -m ruff check . && python -m mypy app/ && python -m pytest tests/ -q
python tests/eval_harness.py          # red-team safety eval must exit 0
# frontend (from PetroBrain Web/)
npm run lint && npm run typecheck && npm test && npm run build
```
Then: branch `feat/track-a-settings`, commit, push, open PR, confirm the full CI board green
(`backend`, `frontend`, `security scan`, `terraform`, `tier-b`), merge. Reveal the page in a
small frontend PR (or the same change set) and confirm Vercel deploys.

## Gotchas (learned the hard way)
- A method named `list` on a class shadows builtin `list` in annotations under
  `from __future__ import annotations` → use `builtins.list[...]` in that file (see the repos).
- `dict_rows=True` connections return dicts at runtime but mypy types them as tuples — `cast`
  where needed.
- The red-team eval (`tests/eval_harness.py`) runs in CI with no API keys (deterministic) and
  is **merge-blocking** — run it locally before pushing.
- `tenant_connection` sets/0-resets the `petrobrain.tenant_id` GUC; never query tenant data
  outside it. RLS is `FORCE`d, so the app role can't see across tenants even with a bad WHERE.

## Then: the remaining Track A slices (same loop)
1. **Analytics + Reports** — `GET /analytics/emissions|insights`, `GET /reports/summary`,
   `POST /reports`, `GET|POST /reports/schedules`, `DELETE /reports/schedules/{id}`.
2. **Data Tools** — `POST /data/import`, `GET /data/template|export|quality`, `POST /data/batch`,
   `GET /data/batch/{id}`.
3. **Emissions rework** — reconcile the frontend emissions client to the backend's existing
   **inventory** model (`POST /emissions/inventory`, `GET /emissions/inventories`) instead of the
   assumed `scope-summary/sources/financed/reports/reconciliation` shape.
