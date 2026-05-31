variable "env" {
  description = "Environment name (dev | prod). Used in resource names + tags."
  type        = string
}

variable "region" {
  type    = string
  default = "af-south-1" # Cape Town - sovereign default
}

variable "image" {
  description = "Container image URI for API + worker."
  type        = string
}

variable "app_port" {
  type    = number
  default = 8000
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket name for documents."
  type        = string
}

variable "certificate_arn" {
  description = "ACM cert ARN for HTTPS (empty = HTTP-only, dev)."
  type        = string
  default     = ""
}

# ---- Sizing / HA toggles -----------------------------------------------------
variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "az_count" {
  type    = number
  default = 2
}

variable "single_nat_gateway" {
  type    = bool
  default = false
}

variable "secret_recovery_window" {
  type    = number
  default = 7
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "db_deletion_protection" {
  type    = bool
  default = false
}

variable "db_skip_final_snapshot" {
  type    = bool
  default = true
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "redis_num_cache_clusters" {
  type    = number
  default = 1
}

variable "redis_automatic_failover" {
  type    = bool
  default = false
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "worker_cpu" {
  type    = number
  default = 512
}

variable "worker_memory" {
  type    = number
  default = 1024
}

variable "llm_provider" {
  type    = string
  default = "anthropic"
}

variable "extra_environment" {
  description = "Additional plaintext env vars merged into the app containers."
  type        = map(string)
  default     = {}
}
