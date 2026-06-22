# Backup, restore & disaster recovery

Scope: the durable stores provisioned in `infra/modules/data`. Redis (ElastiCache) is a
cache/broker holding no system-of-record data, so it is a **failover** concern, not a backup
one. Postgres (RDS) is the system of record; S3 holds uploaded documents.

## What's protected, and how

| Store | Mechanism (`infra/modules/data/main.tf`) | Recovery capability |
|---|---|---|
| **Postgres (RDS)** — system of record | `backup_retention_period = var.db_backup_retention_days` (automated daily snapshots + ~5-min transaction logs); `storage_encrypted = true`; `multi_az = var.db_multi_az`; `deletion_protection`; final snapshot on delete unless `db_skip_final_snapshot` | Point-in-time restore (PITR) to any moment in the retention window; Multi-AZ standby for AZ failure |
| **Documents (S3)** | `aws_s3_bucket_versioning = Enabled`; KMS SSE; public access fully blocked | Per-object version restore (recover an overwrite or delete) |
| **Secrets** | Secrets Manager (`/database-url`, `/redis-url`, `/celery-*`) | AWS-versioned |
| **Redis (ElastiCache)** | replication group + `automatic_failover` + `multi_az` | Failover only — NOT a durable store |

## Targets

| Metric | Target | Basis |
|---|---|---|
| **RPO** — Postgres | ≤ 15 min | RDS ships transaction logs ~every 5 min → PITR granularity ~5 min |
| **RPO** — documents | ≈ 0 | S3 versioning retains overwritten/deleted objects |
| **RTO** — DB, AZ failure | ≤ 5 min | Multi-AZ automatic failover (needs `db_multi_az = true`) |
| **RTO** — DB, full restore | ≤ 60 min | snapshot/PITR restore to a new instance + app cutover |

**Prod prerequisites** (`infra/envs/prod/terraform.tfvars`): `db_multi_az = true`,
`db_backup_retention_days >= 14`, `db_deletion_protection = true`,
`db_skip_final_snapshot = false`.

## Restore drill — run quarterly

> An untested backup is not a backup. This drill measures the real RTO/RPO; a run that misses
> target is a follow-up action, not a pass.

```bash
# 1. PITR to a throwaway instance (~5 min before now).
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier petrobrain-prod-pg \
  --target-db-instance-identifier petrobrain-restore-drill \
  --restore-time "$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" \
  --no-multi-az --db-instance-class db.t3.medium

# 2. Wait until available.
aws rds wait db-instance-available --db-instance-identifier petrobrain-restore-drill

# 3. Verify schema + a tenant row count against the restored DB (read-only).
PB_TEST_DATABASE_URL="postgresql://<user>:<pw>@<restored-endpoint>:5432/petrobrain" \
  python - <<'PY'
from app.db import pg
with pg.connect() as c:
    print("tenants:", c.execute("SELECT count(*) FROM tenants").fetchone()[0])
    print("assets:", c.execute("SELECT count(*) FROM assets").fetchone()[0])
PY

# 4. Tear down the drill instance.
aws rds delete-db-instance --db-instance-identifier petrobrain-restore-drill \
  --skip-final-snapshot
```

| Date | Restore duration (measured RTO) | Data currency (measured RPO) | Result | Notes |
|---|---|---|---|---|
| _pending first drill_ | | | | |

## S3 object restore

```bash
aws s3api list-object-versions --bucket <docs-bucket> --prefix tenants/<tenant>/
aws s3api copy-object --bucket <docs-bucket> --key <key> \
  --copy-source "<docs-bucket>/<key>?versionId=<prior-version-id>"
```

## Gaps / follow-ups
- **Cross-region DR:** backups are in-region. For region-loss DR, enable RDS automated-backup
  replication to a second region and S3 cross-region replication on the docs bucket.
- **Schedule the drill:** wire the quarterly restore drill into the ops calendar (or a
  scheduled job) and fill the log table after the first run.
- **Off Render:** production should run on this AWS/RDS stack (Multi-AZ + PITR) rather than the
  Render free tier, whose ~50s cold start also breaks the first request after idle.
