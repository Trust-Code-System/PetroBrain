# Compute: ECS Fargate cluster running the API (behind the ALB) and the Celery
# worker (same image, different command), each with an ADOT collector sidecar.
# Secrets are injected by the execution role at start; the task role grants the
# app S3 access and the collector X-Ray / CloudWatch EMF.

data "aws_caller_identity" "current" {}

locals {
  env_list     = [for k, v in var.environment : { name = k, value = v }]
  secrets_list = [for k, v in var.app_secrets : { name = k, valueFrom = v }]

  otel_container = {
    name      = "otel-collector"
    image     = var.otel_image
    essential = false
    secrets   = [{ name = "AOT_CONFIG_CONTENT", valueFrom = var.otel_config_param_arn }]
    portMappings = [
      { containerPort = 4317, protocol = "tcp" },
      { containerPort = 4318, protocol = "tcp" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = var.otel_log_group
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "otel"
      }
    }
  }

  clamav_container = {
    name      = "clamav"
    image     = var.clamav_image
    essential = true
    portMappings = [
      { containerPort = 3310, protocol = "tcp" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = var.api_log_group
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "clamav"
      }
    }
  }
}

resource "aws_ecs_cluster" "this" {
  name = "${var.name}-cluster"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ---- IAM ---------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadSecrets"
    actions   = ["secretsmanager:GetSecretValue", "ssm:GetParameters"]
    resources = concat(values(var.app_secrets), [var.otel_config_param_arn])
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${var.name}-exec-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = var.tags
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "DocsBucket"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [var.bucket_arn, "${var.bucket_arn}/*"]
  }
  statement {
    sid = "Telemetry"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "xray:GetSamplingRules",
      "xray:GetSamplingTargets",
      "cloudwatch:PutMetricData",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
  # Off-host immutable audit copy (Option A). The app ships audit rows to the
  # dedicated audit group; scope the write to that group's streams only.
  statement {
    sid       = "AuditOffHost"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [var.audit_log_group_arn, "${var.audit_log_group_arn}:*"]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.name}-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# ---- Task definitions --------------------------------------------------------

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.image
      essential = true
      portMappings = [
        { containerPort = var.app_port, protocol = "tcp" },
      ]
      environment = local.env_list
      secrets     = local.secrets_list
      dependsOn   = [{ containerName = "clamav", condition = "START" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.api_log_group
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "api"
        }
      }
    },
    local.clamav_container,
    local.otel_container,
  ])

  tags = var.tags
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name        = "worker"
      image       = var.image
      essential   = true
      command     = ["celery", "-A", "app.workers.celery_app", "worker", "--loglevel=info", "-Q", "petrobrain.ingest"]
      environment = local.env_list
      secrets     = local.secrets_list
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = var.worker_log_group
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "worker"
        }
      }
    },
    local.otel_container,
  ])

  tags = var.tags
}

# ---- Services ----------------------------------------------------------------

resource "aws_ecs_service" "api" {
  name            = "${var.name}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_sg_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.target_group_arn
    container_name   = "api"
    container_port   = var.app_port
  }

  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  tags = var.tags
}

resource "aws_ecs_service" "worker" {
  name            = "${var.name}-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_sg_id]
    assign_public_ip = false
  }

  tags = var.tags
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}
