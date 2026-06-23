variable "name" {
  type = string
}

variable "alert_email" {
  description = "Email subscribed to the alarm SNS topic. Empty = create the topic + alarms but no subscription (wire PagerDuty/Opsgenie/Slack to the topic out of band)."
  type        = string
  default     = ""
}

# Resource identifiers wired from the other stack modules.
variable "alb_arn_suffix" {
  type = string
}

variable "target_group_arn_suffix" {
  type = string
}

variable "db_instance_id" {
  type = string
}

variable "ecs_cluster_name" {
  type = string
}

variable "ecs_service_name" {
  type = string
}

# Thresholds. Defaults are conservative starting points; tune against the first
# weeks of real traffic in the env root.
variable "alb_5xx_threshold" {
  description = "ELB-generated 5xx per 5 min before alarming (infra/LB problem)."
  type        = number
  default     = 10
}

variable "target_5xx_threshold" {
  description = "App (target) 5xx per 5 min before alarming."
  type        = number
  default     = 25
}

variable "latency_p95_seconds" {
  description = "p95 target response time (seconds) before alarming."
  type        = number
  default     = 2
}

variable "rds_cpu_high_percent" {
  type    = number
  default = 85
}

variable "rds_free_storage_bytes" {
  description = "Alarm when RDS free storage drops below this (default 10 GiB)."
  type        = number
  default     = 10737418240
}

variable "ecs_cpu_high_percent" {
  type    = number
  default = 85
}

variable "tags" {
  type    = map(string)
  default = {}
}
