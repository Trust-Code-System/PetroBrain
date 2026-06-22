# Render cold starts → keep-warm & paid-tier migration

## The problem

The demo backend runs on Render's **free** plan (`render.yaml`, `plan: free`).
Free services spin down after ~15 min idle and cold-start on the next request.
The container then runs DB migrations + imports the app before serving, so the
**first request after idle can take ~50 s and the client sees a 502/503 or a
timeout**. The frontend's `/api/pb` proxy already mitigates this with a
60 s `maxDuration` and one cold-start retry on idempotent calls, but that is a
band-aid, not a fix.

## Option A — keep-warm (cheap, partial)

Ping `/health` more often than the 15 min idle window so the instance never
sleeps. `/health` is unauthenticated and side-effect-free.

- **External cron** (recommended for free tier): a `cron-job.org` / UptimeRobot
  monitor hitting `https://<service>/health` every **10 minutes**.
- **GitHub Actions** alternative (no extra service):
  ```yaml
  # .github/workflows/keep-warm.yml
  name: keep-warm
  on:
    schedule: [{ cron: "*/10 * * * *" }]   # every 10 min (UTC; min granularity ~5 min)
  jobs:
    ping:
      runs-on: ubuntu-latest
      steps:
        - run: curl -fsS --max-time 60 https://<service>/health > /dev/null
  ```

Caveats: keep-warm keeps **one** instance up but does not add capacity or
durability, GitHub's scheduler can lag several minutes, and a warm free instance
still has the free-tier RAM ceiling and ephemeral disk. Treat this as a demo
stopgap only.

## Option B — paid tier (the real fix)

Cold starts are a free-plan property; the durable fix is to leave it. Promotion
steps (already summarised in `render.yaml`'s header):

1. **Web service:** `plan: free` → `plan: starter` ($7/mo). Starter does **not**
   spin down, so the ~50 s cold start disappears.
2. **Database:** add a managed Postgres (Neon, or Render Postgres) and set
   `PB_PERSISTENCE_BACKEND=postgres` + `PB_DATABASE_URL`. This also unlocks the
   RLS isolation guarantees (the free demo uses `PB_ENVIRONMENT=demo`).
3. **Object store:** move off `PB_OBJECT_STORE_BACKEND=memory` to real S3/MinIO
   so uploads (documents, avatars) survive restarts.
4. **Re-enable** `PB_RERANK_ENABLED` once RAM ≥ 1 GB for better RAG quality.
5. Flip `PB_ENVIRONMENT=prod` so `validate_production_settings()` enforces the
   safe-config gate (real JWT secret, postgres backend, TLS Redis, malware scan).

## Recommendation

Keep-warm (Option A) is acceptable **only** for the sales/demo instance. Any
instance holding customer data must be on Option B — the cold-start 502s and the
ephemeral free-tier filesystem are both disqualifying for production, independent
of latency.
