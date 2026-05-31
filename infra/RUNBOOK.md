# PetroBrain Infrastructure RUNBOOK (C2)

Operational procedures for the Tier-A sovereign cloud deployment. Region default
**af-south-1**. All commands assume AWS credentials for the target account and
`cd infra/envs/<env>` (dev | prod).

---

## 0. State backend (one-time per account)

Terraform state lives in S3 with DynamoDB locking. Create them once:

```bash
aws s3api create-bucket --bucket petrobrain-tfstate-<acct> \
  --region af-south-1 --create-bucket-configuration LocationConstraint=af-south-1
aws s3api put-bucket-versioning --bucket petrobrain-tfstate-<acct> \
  --versioning-configuration Status=Enabled
aws dynamodb create-table --table-name petrobrain-tflock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region af-south-1
```

Create `backend.hcl` in each env dir:

```hcl
bucket         = "petrobrain-tfstate-<acct>"
key            = "petrobrain/<env>/terraform.tfstate"
region         = "af-south-1"
dynamodb_table = "petrobrain-tflock"
encrypt        = true
```

---

## 1. Deploy

```bash
terraform init -backend-config=backend.hcl
terraform plan  -var-file=terraform.tfvars -out tfplan   # REVIEW THIS
terraform apply tfplan
```

First-time, after `apply`:

1. **Populate secrets** (Terraform created empty containers):
   ```bash
   aws secretsmanager put-secret-value --secret-id petrobrain-<env>/jwt-secret        --secret-string "$(openssl rand -base64 48)"
   aws secretsmanager put-secret-value --secret-id petrobrain-<env>/anthropic-api-key --secret-string "sk-ant-..."
   aws secretsmanager put-secret-value --secret-id petrobrain-<env>/openai-api-key    --secret-string "sk-..."
   ```
   `database-url` is populated automatically by Terraform.

2. **Run DB migrations** (creates pgvector + tables + RLS). Run a one-off task on
   the cluster, or from a bastion with DB access:
   ```bash
   PB_DATABASE_URL="$(aws secretsmanager get-secret-value \
     --secret-id petrobrain-<env>/database-url --query SecretString --output text)" \
     python -m app.db.pg
   ```
   Then create the NON-superuser app role and grant it (RLS does not bind
   superusers). The RDS master is **not** a superuser, but create a dedicated
   least-privilege role for the app:
   ```sql
   CREATE ROLE petrobrain_app LOGIN PASSWORD '...' NOSUPERUSER;
   GRANT USAGE ON SCHEMA public TO petrobrain_app;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO petrobrain_app;
   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO petrobrain_app;
   -- audit_events is append-only: REVOKE UPDATE, DELETE ON audit_events FROM petrobrain_app;
   ```
   Point `database-url` at `petrobrain_app` for the running app once seeded.

3. **Force a new deployment** so tasks pick up secrets:
   ```bash
   aws ecs update-service --cluster petrobrain-<env>-cluster \
     --service petrobrain-<env>-api --force-new-deployment
   ```

4. Point DNS (CNAME/ALIAS) at the `alb_dns_name` output.

---

## 2. Ship a new image

```bash
docker build -t petrobrain:<tag> .
aws ecr get-login-password | docker login --username AWS --password-stdin <ecr>
docker tag petrobrain:<tag> <ecr>/petrobrain:<tag>
docker push <ecr>/petrobrain:<tag>

# bump `image` in terraform.tfvars, then:
terraform apply -var-file=terraform.tfvars
# ECS rolls the API (min 100% / max 200%) and worker with the new task def.
```

---

## 3. Rollback

- **App rollback**: set `image` back to the previous tag and `terraform apply`,
  or roll the service to the prior task-definition revision:
  ```bash
  aws ecs update-service --cluster petrobrain-<env>-cluster \
    --service petrobrain-<env>-api --task-definition petrobrain-<env>-api:<N-1>
  ```
- **Infra rollback**: `git revert` the Terraform change and `apply`. Review the
  plan - destructive diffs on RDS/Redis are blocked in prod by deletion
  protection; never `-target` your way around that.

---

## 4. Secret / key rotation

```bash
# Application secret (jwt / api keys): put a new version; tasks pick it up on
# next deployment (Terraform ignores the value, so no drift):
aws secretsmanager put-secret-value --secret-id petrobrain-<env>/jwt-secret --secret-string "$(openssl rand -base64 48)"
aws ecs update-service --cluster petrobrain-<env>-cluster --service petrobrain-<env>-api --force-new-deployment

# DB master password: rotate via RDS, then update the database-url secret value
# (or let a rotation Lambda manage it). KMS keys: enable automatic annual
# rotation on the CMKs backing RDS/S3/Secrets.
```

---

## 5. Database backup & restore

- **Backups**: automated daily snapshots (retention 1d dev / 14d prod) +
  point-in-time recovery. Take a manual snapshot before risky changes:
  ```bash
  aws rds create-db-snapshot --db-instance-identifier petrobrain-<env>-pg \
    --db-snapshot-identifier petrobrain-<env>-pg-manual-$(date +%Y%m%d)
  ```
- **Restore (PITR)** into a new instance, then repoint the `database-url` secret:
  ```bash
  aws rds restore-db-instance-to-point-in-time \
    --source-db-instance-identifier petrobrain-<env>-pg \
    --target-db-instance-identifier petrobrain-<env>-pg-restore \
    --restore-time 2026-05-29T12:00:00Z
  ```
  Validate, then update `petrobrain-<env>/database-url` and force a new
  deployment. RLS policies and pgvector come from the migrations, which are
  idempotent - re-run `python -m app.db.pg` against the restored instance if in
  doubt.

---

## 6. Teardown (dev)

```bash
terraform destroy -var-file=terraform.tfvars
```
Prod has `deletion_protection` on RDS and takes a final snapshot - disable
protection deliberately and document why before destroying.

---

## Observability

- Logs: CloudWatch `/petrobrain/<env>/{api,worker,otel-collector}`.
- Traces: X-Ray (via the ADOT sidecar). Metrics: CloudWatch EMF namespace
  `PetroBrain`. Container Insights is on for the cluster.
- App `/metrics` (Prometheus) is also exposed on the API task if you add a
  scraper; OTLP export goes to the sidecar at `localhost:4317`.
