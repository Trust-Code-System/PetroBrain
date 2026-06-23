output "alb_dns_name" {
  description = "Public DNS name of the ALB; point your DNS/CNAME here."
  value       = module.edge.alb_dns_name
}

output "db_endpoint" {
  value = module.data.db_endpoint
}

output "db_url_secret_arn" {
  description = "Secrets Manager ARN of the assembled DATABASE_URL."
  value       = module.data.db_url_secret_arn
}

output "redis_url_secret_arn" {
  description = "Secrets Manager ARN of PB_REDIS_URL."
  value       = module.data.redis_url_secret_arn
}

output "celery_broker_url_secret_arn" {
  description = "Secrets Manager ARN of PB_CELERY_BROKER_URL."
  value       = module.data.celery_broker_url_secret_arn
}

output "celery_result_backend_secret_arn" {
  description = "Secrets Manager ARN of PB_CELERY_RESULT_BACKEND."
  value       = module.data.celery_result_backend_secret_arn
}

output "bucket_id" {
  value = module.data.bucket_id
}

output "cluster_name" {
  value = module.compute.cluster_name
}

output "api_service_name" {
  value = module.compute.api_service_name
}

output "worker_service_name" {
  value = module.compute.worker_service_name
}

output "app_secret_arns" {
  description = "App secrets to populate out-of-band (see RUNBOOK)."
  value       = module.secrets.secret_arns
}

output "alarms_sns_topic_arn" {
  description = "CloudWatch alarm SNS topic; subscribe PagerDuty/Opsgenie/Slack for on-call."
  value       = module.alerting.sns_topic_arn
}
