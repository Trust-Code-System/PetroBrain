output "db_endpoint" {
  value = aws_db_instance.this.address
}

output "db_instance_id" {
  description = "RDS DBInstanceIdentifier, for CloudWatch alarm dimensions."
  value       = aws_db_instance.this.identifier
}

output "db_url_secret_arn" {
  value = aws_secretsmanager_secret.db_url.arn
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "redis_url_secret_arn" {
  value = aws_secretsmanager_secret.redis_url.arn
}

output "celery_broker_url_secret_arn" {
  value = aws_secretsmanager_secret.celery_broker_url.arn
}

output "celery_result_backend_secret_arn" {
  value = aws_secretsmanager_secret.celery_result_backend.arn
}

output "bucket_id" {
  value = aws_s3_bucket.docs.id
}

output "bucket_arn" {
  value = aws_s3_bucket.docs.arn
}
