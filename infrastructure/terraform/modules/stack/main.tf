# Complete platform stack for one environment. envs/dev and envs/prod instantiate this module.

terraform {
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
  }
}

data "aws_region" "current" {}

locals {
  prefix = "lsp-${var.environment}"
  tags   = merge(var.tags, { Project = "live-stream-platform", Environment = var.environment })
  dist   = "${path.root}/../../../../services/api/dist"
}

module "table" {
  source              = "../dynamodb"
  name                = "${local.prefix}-main"
  deletion_protection = var.protect_data
  tags                = local.tags
}

module "media" {
  source                   = "../media_bucket"
  name                     = "${local.prefix}-media-${var.bucket_suffix}"
  recording_retention_days = var.recording_retention_days
  cors_allowed_origins     = var.web_origins
  force_destroy            = !var.protect_data
  tags                     = local.tags
}

module "ses" {
  source = "../ses"
  domain = var.ses_domain
  name   = local.prefix
  tags   = local.tags
}

module "cognito" {
  source              = "../cognito"
  name                = local.prefix
  deletion_protection = var.protect_data
  ses_from_email_arn  = var.cognito_email_via_ses ? module.ses.identity_arn : null
  ses_from_address    = var.cognito_email_via_ses ? var.ses_from_address : null
  tags                = local.tags
}

module "secrets" {
  source               = "../secrets"
  prefix               = "lsp/${var.environment}"
  media_bucket_arn     = module.media.bucket_arn
  recovery_window_days = var.protect_data ? 30 : 0
  tags                 = local.tags
}

resource "aws_cloudwatch_event_bus" "app" {
  name = "${local.prefix}-events"
  tags = local.tags
}

# Archive of domain events (audit / replay), retained 90 days.
resource "aws_cloudwatch_event_archive" "app" {
  name             = "${local.prefix}-archive"
  event_source_arn = aws_cloudwatch_event_bus.app.arn
  retention_days   = 90
}

locals {
  common_env = {
    STAGE                  = var.environment
    TABLE_NAME             = module.table.table_name
    MEDIA_BUCKET           = module.media.bucket_name
    LIVEKIT_URL            = var.livekit_url
    LIVEKIT_SECRET_ARN     = module.secrets.livekit_secret_arn
    EGRESS_S3_SECRET_ARN   = module.secrets.egress_secret_arn
    COGNITO_USER_POOL_ID   = module.cognito.user_pool_id
    COGNITO_CLIENT_IDS     = join(",", [module.cognito.web_client_id, module.cognito.mobile_client_id])
    WEB_BASE_URL           = var.web_base_url
    SES_FROM_ADDRESS       = var.ses_from_address
    SES_CONFIGURATION_SET  = module.ses.configuration_set_name
    EVENT_BUS_NAME         = aws_cloudwatch_event_bus.app.name
    CHAT_RETENTION_DAYS    = tostring(var.chat_retention_days)
    JOIN_TOKEN_TTL_SECONDS = "600"
    LOG_LEVEL              = var.environment == "prod" ? "info" : "debug"
  }
  table_arns = [module.table.table_arn, "${module.table.table_arn}/index/*"]
  ddb_actions = [
    "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
    "dynamodb:Query", "dynamodb:BatchGetItem", "dynamodb:ConditionCheckItem",
  ]
}

module "api_fn" {
  source             = "../lambda_function"
  name               = "${local.prefix}-api"
  source_dir         = "${local.dist}/api"
  memory_mb          = 1024
  timeout_seconds    = 20
  environment        = local.common_env
  log_retention_days = var.log_retention_days
  tags               = local.tags
  policy_statements = [
    { sid = "Table", actions = local.ddb_actions, resources = local.table_arns },
    { sid = "Secrets", actions = ["secretsmanager:GetSecretValue"], resources = [module.secrets.livekit_secret_arn, module.secrets.egress_secret_arn] },
    { sid = "Thumbnails", actions = ["s3:GetObject", "s3:PutObject"], resources = ["${module.media.bucket_arn}/thumbnails/*"] },
    { sid = "Recordings", actions = ["s3:GetObject", "s3:DeleteObject"], resources = ["${module.media.bucket_arn}/recordings/*"] },
    { sid = "Email", actions = ["ses:SendEmail"], resources = [module.ses.identity_arn, module.ses.configuration_set_arn] },
    { sid = "Events", actions = ["events:PutEvents"], resources = [aws_cloudwatch_event_bus.app.arn] },
  ]
}

module "webhook_fn" {
  source             = "../lambda_function"
  name               = "${local.prefix}-webhook"
  source_dir         = "${local.dist}/webhook"
  memory_mb          = 512
  timeout_seconds    = 15
  environment        = local.common_env
  log_retention_days = var.log_retention_days
  tags               = local.tags
  policy_statements = [
    { sid = "Table", actions = local.ddb_actions, resources = local.table_arns },
    { sid = "Secrets", actions = ["secretsmanager:GetSecretValue"], resources = [module.secrets.livekit_secret_arn] },
    { sid = "Events", actions = ["events:PutEvents"], resources = [aws_cloudwatch_event_bus.app.arn] },
  ]
}

module "jobs_fn" {
  source               = "../lambda_function"
  name                 = "${local.prefix}-jobs"
  source_dir           = "${local.dist}/jobs"
  memory_mb            = 512
  timeout_seconds      = 120
  reserved_concurrency = 2
  environment          = local.common_env
  log_retention_days   = var.log_retention_days
  tags                 = local.tags
  policy_statements = [
    { sid = "Table", actions = local.ddb_actions, resources = local.table_arns },
    { sid = "Secrets", actions = ["secretsmanager:GetSecretValue"], resources = [module.secrets.livekit_secret_arn] },
    { sid = "Events", actions = ["events:PutEvents"], resources = [aws_cloudwatch_event_bus.app.arn] },
  ]
}

module "api" {
  source               = "../http_api"
  name                 = local.prefix
  cors_allowed_origins = var.web_origins
  jwt_issuer           = module.cognito.issuer
  jwt_audiences        = [module.cognito.web_client_id, module.cognito.mobile_client_id]
  api_lambda           = { function_name = module.api_fn.function_name, invoke_arn = module.api_fn.invoke_arn }
  webhook_lambda       = { function_name = module.webhook_fn.function_name, invoke_arn = module.webhook_fn.invoke_arn }
  log_retention_days   = var.log_retention_days
  tags                 = local.tags
}

# ---------------------------------------------------------------- Scheduled jobs (EventBridge Scheduler)
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.prefix}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "lambda:InvokeFunction", Resource = module.jobs_fn.function_arn }]
  })
}

locals {
  schedules = {
    reconcile = "rate(2 minutes)"
    reminders = "rate(5 minutes)"
    cleanup   = "rate(1 hour)"
  }
}

resource "aws_scheduler_schedule" "jobs" {
  for_each   = local.schedules
  name       = "${local.prefix}-${each.key}"
  group_name = "default"
  flexible_time_window {
    mode = "OFF"
  }
  schedule_expression = each.value
  target {
    arn      = module.jobs_fn.function_arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ job = each.key })
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

module "monitoring" {
  source                 = "../monitoring"
  name                   = local.prefix
  alarm_email            = var.alarm_email
  lambda_function_names  = [module.api_fn.function_name, module.webhook_fn.function_name, module.jobs_fn.function_name]
  api_id                 = module.api.api_id
  table_name             = module.table.table_name
  webhook_log_group_name = "/aws/lambda/${module.webhook_fn.function_name}"
  tags                   = local.tags
}

# ---------------------------------------------------------------- Amplify Hosting (optional)
resource "aws_amplify_app" "web" {
  count                    = var.amplify_repository == null ? 0 : 1
  name                     = "${local.prefix}-web"
  repository               = var.amplify_repository
  access_token             = var.amplify_github_token
  platform                 = "WEB_COMPUTE"
  enable_branch_auto_build = true
  build_spec               = file("${path.module}/amplify-buildspec.yml")
  environment_variables = {
    AMPLIFY_MONOREPO_APP_ROOT         = "apps/web"
    NEXT_PUBLIC_API_URL               = module.api.api_endpoint
    NEXT_PUBLIC_AUTH_MODE             = "cognito"
    NEXT_PUBLIC_COGNITO_USER_POOL_ID  = module.cognito.user_pool_id
    NEXT_PUBLIC_COGNITO_WEB_CLIENT_ID = module.cognito.web_client_id
    NEXT_PUBLIC_LIVEKIT_WS_ORIGIN     = var.livekit_url
  }
  tags = local.tags
}

resource "aws_amplify_branch" "web" {
  count       = var.amplify_repository == null ? 0 : 1
  app_id      = aws_amplify_app.web[0].id
  branch_name = var.amplify_branch
  stage       = var.environment == "prod" ? "PRODUCTION" : "DEVELOPMENT"
  framework   = "Next.js - SSR"
}
