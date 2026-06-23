# Alerting: an SNS topic + CloudWatch alarms covering the user-facing failure
# modes (LB 5xx, app 5xx, no healthy targets, latency) and the saturation signals
# that precede them (RDS CPU/storage, ECS CPU). The observability module already
# ships logs + traces + metrics; this is the missing "wake someone up" layer.
#
# Every alarm sends to one SNS topic for both ALARM and OK transitions. Subscribe
# an email here, or wire the topic ARN (output) to PagerDuty/Opsgenie/Slack.

resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarms"
  tags = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

locals {
  actions = [aws_sns_topic.alarms.arn]
}

# --- Edge / user-facing -------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx"
  alarm_description   = "ELB-generated 5xx elevated (load balancer / no-target errors)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.alb_5xx_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  alarm_name          = "${var.name}-target-5xx"
  alarm_description   = "Application (target) 5xx elevated."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.target_5xx_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "no_healthy_hosts" {
  alarm_name          = "${var.name}-no-healthy-hosts"
  alarm_description   = "Target group has fewer than 1 healthy host - the API is effectively down."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  # Missing data here usually means the LB stopped reporting healthy targets.
  treat_missing_data = "breaching"
  alarm_actions      = local.actions
  ok_actions         = local.actions
  tags               = var.tags
}

resource "aws_cloudwatch_metric_alarm" "latency_p95" {
  alarm_name          = "${var.name}-latency-p95"
  alarm_description   = "p95 target response time above budget."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.latency_p95_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

# --- Data tier ----------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name}-rds-cpu-high"
  alarm_description   = "RDS CPU sustained high."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.db_instance_id }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.rds_cpu_high_percent
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${var.name}-rds-free-storage-low"
  alarm_description   = "RDS free storage below floor - risk of write failures."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.db_instance_id }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.rds_free_storage_bytes
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}

# --- Audit / security -----------------------------------------------------------
# The app emits a greppable "audit_security_event" WARNING to stdout when a
# security-relevant audit row is written (e.g. a guardrail bypass attempt) - see
# app/db/audit_events_repository.py. A log metric filter turns each occurrence
# into a metric; the alarm pages on-call. This is the out-of-band path the
# in-app admin notification does not provide.
resource "aws_cloudwatch_log_metric_filter" "audit_security_event" {
  name           = "${var.name}-audit-security-event"
  log_group_name = var.api_log_group
  pattern        = "audit_security_event"

  metric_transformation {
    name          = "AuditSecurityEvents"
    namespace     = "PetroBrain/${var.name}"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "audit_security_event" {
  alarm_name          = "${var.name}-audit-security-event"
  alarm_description   = "A security-relevant audit event (e.g. guardrail bypass attempt) was recorded - review immediately."
  namespace           = "PetroBrain/${var.name}"
  metric_name         = "AuditSecurityEvents"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  # No ok_actions: a security event is a point-in-time signal, not a sustained
  # state, so an "OK" transition would just be noise.
  tags = var.tags
}

# The app emits a greppable "audit_write_failed" ERROR to stdout when a durable
# audit append raises (DB down / permission denied) or the off-host CloudWatch
# copy fails (see app/core/audit_sink.py). That means actions may be happening
# without being recorded - page immediately. Same filter+alarm shape as
# audit_security_event above.
resource "aws_cloudwatch_log_metric_filter" "audit_write_failed" {
  name           = "${var.name}-audit-write-failed"
  log_group_name = var.api_log_group
  pattern        = "audit_write_failed"

  metric_transformation {
    name          = "AuditWriteFailures"
    namespace     = "PetroBrain/${var.name}"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "audit_write_failed" {
  alarm_name          = "${var.name}-audit-write-failed"
  alarm_description   = "An audit write failed (durable append or off-host copy) - actions may be unrecorded. Investigate immediately."
  namespace           = "PetroBrain/${var.name}"
  metric_name         = "AuditWriteFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  # No ok_actions: a write failure is a point-in-time signal, not a sustained
  # state, so an "OK" transition would just be noise.
  tags = var.tags
}

# --- Embeddings / provider ----------------------------------------------------
# The app logs a greppable "embedding_provider_failed" WARNING whenever an
# embedding-provider call fails (see app/rag/embeddings.py). The raw cause - most
# often an OpenAI 429 "insufficient_quota" - is sanitized before it reaches users,
# so without this alarm a quota exhaustion is invisible until someone notices that
# document ingestion and RAG retrieval have quietly stopped working. Ingestion
# runs in the worker and retrieval in the API, so we scan BOTH log groups into one
# metric.
resource "aws_cloudwatch_log_metric_filter" "embedding_provider_failed_api" {
  name           = "${var.name}-embedding-provider-failed-api"
  log_group_name = var.api_log_group
  pattern        = "embedding_provider_failed"

  metric_transformation {
    name          = "EmbeddingProviderFailures"
    namespace     = "PetroBrain/${var.name}"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "embedding_provider_failed_worker" {
  name           = "${var.name}-embedding-provider-failed-worker"
  log_group_name = var.worker_log_group
  pattern        = "embedding_provider_failed"

  metric_transformation {
    name          = "EmbeddingProviderFailures"
    namespace     = "PetroBrain/${var.name}"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "embedding_provider_failed" {
  alarm_name          = "${var.name}-embedding-provider-failed"
  alarm_description   = "Embedding provider failing (e.g. out of quota) - document ingestion and RAG retrieval are degraded. Check the provider key/billing or fail over to self-hosted embeddings."
  namespace           = "PetroBrain/${var.name}"
  metric_name         = "EmbeddingProviderFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.embedding_failure_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  # ok_actions here is useful: recovery (key topped up / failover) is a real,
  # sustained state transition worth telling on-call about.
  ok_actions = local.actions
  tags       = var.tags
}

# --- Compute tier -------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_cpu" {
  alarm_name          = "${var.name}-ecs-api-cpu-high"
  alarm_description   = "ECS API service CPU sustained high (scale up or investigate)."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = var.ecs_service_name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.ecs_cpu_high_percent
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions
  tags                = var.tags
}
