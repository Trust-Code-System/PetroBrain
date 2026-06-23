output "sns_topic_arn" {
  description = "Subscribe PagerDuty/Opsgenie/Slack to this for on-call delivery."
  value       = aws_sns_topic.alarms.arn
}
