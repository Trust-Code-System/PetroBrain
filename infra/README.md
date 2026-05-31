# PetroBrain - Sovereign Cloud Infrastructure (C2)

Terraform for the Tier-A hosted deployment. Default region **af-south-1 (Cape
Town)** to keep data in-region. Two environments, `dev` and `prod`, compose the
same modules with different sizing/HA toggles.

> Offline-validated only in this repo (`terraform fmt` + `validate`). No
> `plan`/`apply` has run against AWS - review a real `terraform plan` before
> applying. See [RUNBOOK.md](RUNBOOK.md) for the deploy/rollback/restore steps.

## Layout

```
infra/
  modules/
    network/        VPC, public+private subnets, NAT, edge/app/data security groups
    secrets/        Secrets Manager containers (jwt, anthropic, openai) - values set out-of-band
    data/           RDS Postgres (pgvector), ElastiCache Redis, S3 docs bucket, DATABASE_URL secret
    observability/  CloudWatch log groups + ADOT/OTLP collector config (SSM)
    edge/           Application Load Balancer + WAFv2 web ACL
    compute/        ECS Fargate cluster, IAM, API + worker task defs (ADOT sidecar), services
    stack/          Composes all of the above into one environment
  envs/
    dev/            Thin root: cheap, single-AZ, HTTP-only
    prod/           Thin root: multi-AZ, deletion protection, HTTPS, larger instances
```

## Architecture

```
Internet ─▶ WAFv2 ─▶ ALB (public subnets) ─▶ ECS API service (private)
                                                 │  ├─ api container  :8000
                                                 │  └─ adot sidecar   :4317 ─▶ X-Ray / CloudWatch
                                                 ▼
                          ECS worker service (private)  ── Celery, same image
                                                 │
   RDS Postgres (pgvector)  ◀──┐                 │
   ElastiCache Redis        ◀──┼── data SG (app-only ingress)
   S3 docs bucket (KMS)     ◀──┘   (via task role)
```

Tenant isolation rides on top of this: every repository sets the
`petrobrain.tenant_id` GUC and the Postgres RLS policies enforce it
(`PB_PERSISTENCE_BACKEND=postgres`, wired by the stack module).

## Prerequisites

- Terraform >= 1.6, AWS credentials for the target account/region.
- An ECR repository with the PetroBrain image pushed (API + worker share it).
- An S3 bucket + DynamoDB table for remote state (see RUNBOOK § State backend).
- (prod) an ACM certificate for the API hostname.

## Usage

```bash
cd infra/envs/dev          # or prod
terraform init -backend-config=backend.hcl
terraform plan  -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
# then populate the app secrets and run DB migrations - see RUNBOOK.md
```

Edit `terraform.tfvars` first: set `image`, a globally-unique `bucket_name`,
and (prod) `certificate_arn`.

## dev vs prod

| | dev | prod |
|---|---|---|
| NAT gateways | 1 (shared) | 1 per AZ |
| AZs | 2 | 3 |
| RDS | t4g.medium, single-AZ | r6g.large, multi-AZ |
| RDS deletion protection | off | on |
| Final snapshot | skipped | taken |
| Redis | 1 node | 2 nodes, auto-failover |
| API / worker tasks | 1 / 1 | 2 / 2 |
| TLS | HTTP-only | HTTPS (ACM) |
| Log retention | 14d | 90d |

## Known follow-ups

- **Redis TLS/auth**: transit encryption is off (private-subnet + SG only). Enable
  `transit_encryption_enabled` + auth token once the app's Redis URL supports
  `rediss://`.
- **Provider lock**: `.terraform.lock.hcl` is gitignored because it was generated
  for one platform here; run `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`
  and commit it deliberately.
- **CI**: a `terraform fmt -check` + `validate` job can be added to the pipeline
  once the repo has a remote.
