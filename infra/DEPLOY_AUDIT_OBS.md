# Deploy guide: off-host audit copy + error/embedding observability

Apply procedure for the infrastructure added in:

- **PR #12** - off-host immutable audit copy + `audit_write_failed` alarm (Option A)
- **PR #14** - `embedding_provider_failed` alarm + `worker_log_group` wiring

The app-side changes (PR #13 sanitized embedding errors, PR #15 auto error
capture) ship inside the container image and need **no** infra step - they take
effect when you deploy an image built from `main`.

This is a supplement to `infra/RUNBOOK.md`, not a replacement. The generic
state-backend / init / plan / apply steps live there (sections 0 and 1); this doc
only calls out what is specific to these changes.

---

## What the plan will show

All new resources live inside `module.stack`. None are destructive; there are no
RDS / Redis / VPC diffs.

| Resource | Module | What it is |
| --- | --- | --- |
| `aws_cloudwatch_log_group.audit` | observability | `/petrobrain/<env>/audit`, 400-day retention (the off-host audit copy target) |
| `data.aws_iam_policy_document.task` -> `AuditOffHost` statement | compute | task role granted `logs:CreateLogStream` + `logs:PutLogEvents` on the audit group ARN **only** |
| `aws_cloudwatch_log_metric_filter.audit_write_failed` | alerting | metric filter on the `audit_write_failed` marker (api log group) |
| `aws_cloudwatch_metric_alarm.audit_write_failed` | alerting | alarm -> SNS when an audit write fails |
| `aws_cloudwatch_log_metric_filter.embedding_provider_failed_api` | alerting | `embedding_provider_failed` marker (api log group) |
| `aws_cloudwatch_log_metric_filter.embedding_provider_failed_worker` | alerting | `embedding_provider_failed` marker (worker log group) |
| `aws_cloudwatch_metric_alarm.embedding_provider_failed` | alerting | alarm -> SNS when embeddings fail (e.g. out of quota) |

The API + worker **task definitions** also change, because the stack now sets
`PB_AUDIT_CLOUDWATCH_ENABLED=true`, `PB_AUDIT_CLOUDWATCH_LOG_GROUP`, and
`PB_AUDIT_CLOUDWATCH_REGION` on the app. ECS rolls a new deployment automatically
when the task def changes.

---

## Prerequisites

- AWS credentials for the target account; region `af-south-1`.
- Terraform `1.9.x` (CI pins `1.9.8`; the repo is validated against it).
- `terraform.tfvars` filled with real values (no `CHANGE-ME`): `image`,
  `bucket_name`, `certificate_arn` (prod), `cors_allow_origins`.
- The deployed image is built from `main` (so it contains the merged app code).
  Ship it first per `RUNBOOK.md` section 2 if needed.

---

## Scenario A - infrastructure already deployed (state exists)

An incremental apply: only the resources above plus the two task-def updates.

```bash
cd infra/envs/<env>            # dev | prod
terraform init -backend-config=backend.hcl
terraform plan -var-file=terraform.tfvars -out tfplan   # REVIEW: expect only the rows above + 2 task-def updates
terraform apply tfplan
```

The task-def change triggers a rolling ECS deploy on its own. No manual
`update-service` is required for these changes.

---

## Scenario B - first-ever apply (no state yet)

This is the repo's current state: not yet bootstrapped (placeholder tfvars, no
`backend.hcl`, no remote state). A first apply stands up the **entire** stack
(VPC, RDS, ElastiCache, ECS, ALB, ...), not just these resources, and is a real,
billable production bring-up.

Do the full first-time procedure in `RUNBOOK.md` sections 0 -> 1 (create the
state backend, fill `image` / `bucket_name` / `certificate_arn` / `cors_allow_origins`,
populate secrets, run migrations, point DNS, subscribe on-call). The audit and
observability resources come up as part of that same apply - there is no separate
step for them.

---

## Post-apply verification (these changes)

```bash
# 1. The off-host audit log group exists with long retention.
aws logs describe-log-groups --log-group-name-prefix /petrobrain/<env>/audit \
  --query 'logGroups[0].{name:logGroupName,retentionDays:retentionInDays}'

# 2. The three new alarms exist.
aws cloudwatch describe-alarms \
  --alarm-name-prefix petrobrain-<env>-audit-write-failed \
  --query 'MetricAlarms[].AlarmName'
aws cloudwatch describe-alarms \
  --alarm-name-prefix petrobrain-<env>-embedding-provider-failed \
  --query 'MetricAlarms[].AlarmName'

# 3. After some real traffic, audit rows are landing off-host: a stream appears.
aws logs describe-log-streams --log-group-name /petrobrain/<env>/audit \
  --order-by LastEventTime --descending --max-items 1
```

If on-call is not yet subscribed to the alarm SNS topic, do it now - otherwise
these alarms fire into a topic nobody hears. Set `alert_email` in
`terraform.tfvars` and re-apply, or subscribe PagerDuty/Opsgenie/Slack to the
`alarms_sns_topic_arn` output (RUNBOOK section 1 step 7).

---

## Rollback

`git revert` the PRs and apply (RUNBOOK section 3). The only stateful resource is
the audit log group; reverting removes it and the off-host copy it holds. The
durable `audit_events` table in Postgres is untouched, so the audit trail itself
is not lost.

---

## Notes

- The off-host audit copy defaults **OFF** in code; the stack module is what sets
  `PB_AUDIT_CLOUDWATCH_ENABLED=true` for the cloud deployment. The Render demo and
  dev laptops stay off.
- Both new alarms depend on a log metric filter over the api (and worker) log
  groups, so the app must be logging to those groups - it is, via
  `PB_LOG_JSON=true` and the awslogs driver the compute module configures.
- The `embedding_provider_failed` alarm threshold is tunable via
  `embedding_failure_threshold` on the alerting module (default 5 per 5 min).
