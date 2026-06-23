provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "PetroBrain"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

module "stack" {
  source = "../../modules/stack"

  env                = "prod"
  region             = var.region
  image              = var.image
  bucket_name        = var.bucket_name
  certificate_arn    = var.certificate_arn
  cors_allow_origins = var.cors_allow_origins
  alert_email        = var.alert_email

  # Prod posture: multi-AZ, deletion protection, longer retention, HTTPS.
  single_nat_gateway               = false
  az_count                         = 3
  db_instance_class                = "db.r6g.large"
  db_allocated_storage             = 100
  db_multi_az                      = true
  db_backup_retention_days         = 14
  db_deletion_protection           = true
  db_skip_final_snapshot           = false
  secret_recovery_window           = 7
  log_retention_days               = 90
  redis_node_type                  = "cache.r6g.large"
  redis_num_cache_clusters         = 2
  redis_automatic_failover         = true
  redis_transit_encryption_enabled = true
  api_desired_count                = 2
  worker_desired_count             = 2
  api_cpu                          = 1024
  api_memory                       = 2048
  worker_cpu                       = 1024
  worker_memory                    = 2048
}
