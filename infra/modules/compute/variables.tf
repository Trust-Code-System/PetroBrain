variable "name" {
  type = string
}

variable "region" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "app_sg_id" {
  type = string
}

variable "image" {
  description = "Container image URI for the API + worker (same image, different command)."
  type        = string
}

variable "app_port" {
  type    = number
  default = 8000
}

variable "environment" {
  description = "Plaintext env vars injected into the app containers."
  type        = map(string)
  default     = {}
}

variable "app_secrets" {
  description = "Env var name -> Secrets Manager/SSM ARN, injected as ECS secrets."
  type        = map(string)
  default     = {}
}

variable "otel_config_param_arn" {
  type = string
}

variable "api_log_group" {
  type = string
}

variable "worker_log_group" {
  type = string
}

variable "otel_log_group" {
  type = string
}

variable "target_group_arn" {
  type = string
}

variable "bucket_arn" {
  description = "S3 docs bucket ARN the task role may read/write."
  type        = string
}

variable "audit_log_group_arn" {
  description = "ARN of the dedicated off-host audit log group. The task role is granted CreateLogStream + PutLogEvents on this group only."
  type        = string
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

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "otel_image" {
  type    = string
  default = "public.ecr.aws/aws-observability/aws-otel-collector:latest"
}

variable "clamav_image" {
  type    = string
  default = "clamav/clamav-debian:stable"
}

variable "tags" {
  type    = map(string)
  default = {}
}
