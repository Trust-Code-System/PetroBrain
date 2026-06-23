region = "af-south-1"

# --- FILL THESE THREE before `terraform apply` (need your AWS account) --------
# 1. ECR image URI you pushed the API/worker image to.
# 2. A globally-unique S3 bucket name for documents.
# 3. The ACM certificate ARN for the API hostname (HTTPS is required in prod).
image           = "ACCOUNT_ID.dkr.ecr.af-south-1.amazonaws.com/petrobrain:prod"
bucket_name     = "petrobrain-docs-prod-CHANGE-ME"
certificate_arn = "arn:aws:acm:af-south-1:ACCOUNT_ID:certificate/CHANGE-ME"

# Real deployed web/admin origins (https only; no localhost/wildcards - the
# variable validation enforces this). These match the current frontend.
cors_allow_origins = "https://petrobrain.xyz,https://www.petrobrain.xyz,https://petrobrain.vercel.app"

# Email subscribed to the CloudWatch alarm SNS topic (no-healthy-hosts, 5xx,
# RDS/ECS saturation). Leave "" to create the topic without a subscription and
# wire PagerDuty/Slack to the `alarms_sns_topic_arn` output instead.
alert_email = ""
