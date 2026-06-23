# Stack: composes the network, secrets, data, observability, edge and compute
# modules into one PetroBrain environment. The dev/prod roots are thin wrappers
# that pass sizing + HA toggles, keeping the wiring defined once here.

locals {
  name = "petrobrain-${var.env}"
  tags = {
    Project     = "PetroBrain"
    Environment = var.env
    ManagedBy   = "terraform"
  }

  app_environment = merge({
    PB_ENVIRONMENT                 = var.env
    PB_CORS_ALLOW_ORIGINS          = var.cors_allow_origins
    PB_LLM_PROVIDER                = var.llm_provider
    PB_PERSISTENCE_BACKEND         = "postgres"
    PB_OBJECT_STORE_BACKEND        = "s3"
    PB_OBJECT_STORE_BUCKET         = module.data.bucket_id
    PB_OBJECT_STORE_REGION         = var.region
    PB_OBJECT_STORE_ENDPOINT       = "" # AWS S3 default endpoint; task role provides creds
    PB_OBJECT_STORE_USE_PATH_STYLE = "false"
    PB_OTEL_ENDPOINT               = "http://localhost:4317" # ADOT sidecar
    PB_SOVEREIGN_REGION            = var.region
    PB_METRICS_ENABLED             = "true"
    PB_LOG_JSON                    = "true"
    PB_OPERATIONAL_TIER            = "false"
    PB_ENABLE_SELF_SIGNUP          = "false"
    PB_MALWARE_SCAN_ENABLED        = "true"
    PB_MALWARE_SCAN_FAIL_CLOSED    = "true"
    PB_MALWARE_SCAN_HOST           = "127.0.0.1"
    PB_MALWARE_SCAN_PORT           = "3310"
  }, var.extra_environment)

  app_secrets = {
    PB_DATABASE_URL          = module.data.db_url_secret_arn
    PB_REDIS_URL             = module.data.redis_url_secret_arn
    PB_CELERY_BROKER_URL     = module.data.celery_broker_url_secret_arn
    PB_CELERY_RESULT_BACKEND = module.data.celery_result_backend_secret_arn
    PB_JWT_SECRET            = module.secrets.secret_arns["jwt-secret"]
    PB_METRICS_AUTH_TOKEN    = module.secrets.secret_arns["metrics-auth-token"]
    ANTHROPIC_API_KEY        = module.secrets.secret_arns["anthropic-api-key"]
    OPENAI_API_KEY           = module.secrets.secret_arns["openai-api-key"]
  }
}

module "network" {
  source             = "../network"
  name               = local.name
  cidr               = var.vpc_cidr
  az_count           = var.az_count
  single_nat_gateway = var.single_nat_gateway
  app_port           = var.app_port
  tags               = local.tags
}

module "secrets" {
  source                  = "../secrets"
  name                    = local.name
  recovery_window_in_days = var.secret_recovery_window
  tags                    = local.tags
}

module "data" {
  source                           = "../data"
  name                             = local.name
  private_subnet_ids               = module.network.private_subnet_ids
  data_sg_id                       = module.network.data_sg_id
  db_instance_class                = var.db_instance_class
  db_allocated_storage             = var.db_allocated_storage
  db_multi_az                      = var.db_multi_az
  db_backup_retention_days         = var.db_backup_retention_days
  db_deletion_protection           = var.db_deletion_protection
  db_skip_final_snapshot           = var.db_skip_final_snapshot
  redis_node_type                  = var.redis_node_type
  redis_num_cache_clusters         = var.redis_num_cache_clusters
  redis_automatic_failover         = var.redis_automatic_failover
  redis_transit_encryption_enabled = var.redis_transit_encryption_enabled
  bucket_name                      = var.bucket_name
  tags                             = local.tags
}

module "observability" {
  source             = "../observability"
  name               = var.env
  region             = var.region
  log_retention_days = var.log_retention_days
  tags               = local.tags
}

module "edge" {
  source            = "../edge"
  name              = local.name
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  alb_sg_id         = module.network.alb_sg_id
  app_port          = var.app_port
  certificate_arn   = var.certificate_arn
  tags              = local.tags
}

module "compute" {
  source                = "../compute"
  name                  = local.name
  region                = var.region
  private_subnet_ids    = module.network.private_subnet_ids
  app_sg_id             = module.network.app_sg_id
  image                 = var.image
  app_port              = var.app_port
  environment           = local.app_environment
  app_secrets           = local.app_secrets
  otel_config_param_arn = module.observability.otel_config_param_arn
  api_log_group         = module.observability.api_log_group
  worker_log_group      = module.observability.worker_log_group
  otel_log_group        = module.observability.otel_log_group
  target_group_arn      = module.edge.target_group_arn
  bucket_arn            = module.data.bucket_arn
  api_cpu               = var.api_cpu
  api_memory            = var.api_memory
  worker_cpu            = var.worker_cpu
  worker_memory         = var.worker_memory
  api_desired_count     = var.api_desired_count
  worker_desired_count  = var.worker_desired_count
  tags                  = local.tags

  # The ALB listener must exist before the service registers into the TG.
  depends_on = [module.edge]
}

module "alerting" {
  source                  = "../alerting"
  name                    = local.name
  alert_email             = var.alert_email
  alb_arn_suffix          = module.edge.alb_arn_suffix
  target_group_arn_suffix = module.edge.target_group_arn_suffix
  db_instance_id          = module.data.db_instance_id
  ecs_cluster_name        = module.compute.cluster_name
  ecs_service_name        = module.compute.api_service_name
  tags                    = local.tags
}
