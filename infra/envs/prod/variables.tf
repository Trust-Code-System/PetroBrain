variable "region" {
  type    = string
  default = "af-south-1"
}

variable "image" {
  description = "Container image URI for API + worker (ECR)."
  type        = string
}

variable "bucket_name" {
  description = "Globally-unique S3 document bucket name."
  type        = string
}

variable "certificate_arn" {
  description = "ACM cert ARN for HTTPS (required in prod)."
  type        = string
}

variable "alert_email" {
  description = "Email subscribed to the CloudWatch alarm SNS topic. Leave empty to create the topic + alarms without a subscription and wire PagerDuty/Slack to the topic ARN out of band."
  type        = string
  default     = ""
}

variable "cors_allow_origins" {
  description = "Comma-separated production web/admin origins, e.g. https://app.example.com,https://admin.example.com."
  type        = string

  validation {
    condition = (
      length(trimspace(var.cors_allow_origins)) > 0
      && !strcontains(var.cors_allow_origins, "*")
      && !strcontains(lower(var.cors_allow_origins), "localhost")
      && !strcontains(var.cors_allow_origins, "127.0.0.1")
      && length([
        for origin in split(",", var.cors_allow_origins) : origin
        if startswith(trimspace(origin), "https://")
      ]) == length(split(",", var.cors_allow_origins))
    )
    error_message = "cors_allow_origins must be a non-empty comma-separated list of https:// production origins; localhost, 127.0.0.1, and * are not allowed."
  }
}
