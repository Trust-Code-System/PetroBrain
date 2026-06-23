# Observability: CloudWatch log groups per service and the ADOT (OpenTelemetry)
# collector configuration stored in SSM. The collector runs as a sidecar in the
# app tasks (see the compute module); the app exports OTLP to localhost:4317 and
# the collector fans out to X-Ray (traces) and CloudWatch EMF (metrics).

variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "audit_log_retention_days" {
  description = "Retention for the off-host immutable audit copy. Long by default so the durable audit trail outlives operational logs."
  type        = number
  default     = 400
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/petrobrain/${var.name}/api"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/petrobrain/${var.name}/worker"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "otel" {
  name              = "/petrobrain/${var.name}/otel-collector"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

# Off-host immutable audit copy (Option A). Dedicated group, separate from the
# noisy api group, with long retention so the durable audit trail outlives the
# operational logs. The app ships each audit row here via logs:PutLogEvents; the
# task role is granted CreateLogStream/PutLogEvents on THIS group only.
resource "aws_cloudwatch_log_group" "audit" {
  name              = "/petrobrain/${var.name}/audit"
  retention_in_days = var.audit_log_retention_days
  tags              = var.tags
}

locals {
  otel_config = <<-YAML
    receivers:
      otlp:
        protocols:
          grpc:
            endpoint: 0.0.0.0:4317
          http:
            endpoint: 0.0.0.0:4318
    processors:
      batch:
        timeout: 5s
    exporters:
      awsxray:
        region: ${var.region}
      awsemf:
        region: ${var.region}
        namespace: PetroBrain
        log_group_name: ${aws_cloudwatch_log_group.otel.name}
    service:
      pipelines:
        traces:
          receivers: [otlp]
          processors: [batch]
          exporters: [awsxray]
        metrics:
          receivers: [otlp]
          processors: [batch]
          exporters: [awsemf]
  YAML
}

resource "aws_ssm_parameter" "otel_config" {
  name        = "/petrobrain/${var.name}/otel-collector-config"
  description = "ADOT collector config (injected as AOT_CONFIG_CONTENT)."
  type        = "String"
  value       = local.otel_config
  tags        = var.tags
}

output "api_log_group" {
  value = aws_cloudwatch_log_group.api.name
}

output "worker_log_group" {
  value = aws_cloudwatch_log_group.worker.name
}

output "otel_log_group" {
  value = aws_cloudwatch_log_group.otel.name
}

output "audit_log_group" {
  value = aws_cloudwatch_log_group.audit.name
}

output "audit_log_group_arn" {
  value = aws_cloudwatch_log_group.audit.arn
}

output "otel_config_param_arn" {
  value = aws_ssm_parameter.otel_config.arn
}
