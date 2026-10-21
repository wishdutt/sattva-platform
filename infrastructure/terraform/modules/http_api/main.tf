# API Gateway HTTP API: JWT-authorized REST routes + an unauthenticated (signature-verified) webhook route.

variable "name" { type = string }
variable "cors_allowed_origins" { type = list(string) }
variable "jwt_issuer" { type = string }
variable "jwt_audiences" { type = list(string) }
variable "api_lambda" {
  type = object({ function_name = string, invoke_arn = string })
}
variable "webhook_lambda" {
  type = object({ function_name = string, invoke_arn = string })
}
variable "throttle_rate_limit" {
  type    = number
  default = 200
}
variable "throttle_burst_limit" {
  type    = number
  default = 400
}
variable "log_retention_days" {
  type    = number
  default = 30
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins  = var.cors_allowed_origins
    allow_methods  = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    allow_headers  = ["authorization", "content-type", "idempotency-key"]
    expose_headers = ["x-request-id"]
    max_age        = 600
  }
  tags = var.tags
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.this.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    issuer   = var.jwt_issuer
    audience = var.jwt_audiences
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.api_lambda.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_integration" "webhook" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.webhook_lambda.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api" {
  for_each           = toset(["GET", "POST", "PATCH", "DELETE"])
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = "${each.key} /api/v1/{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

# More specific route wins over /api/v1/{proxy+}; LiveKit signs the request body instead of a JWT.
resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /api/v1/webhooks/livekit"
  target    = "integrations/${aws_apigatewayv2_integration.webhook.id}"
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_rate_limit  = var.throttle_rate_limit
    throttling_burst_limit = var.throttle_burst_limit
  }
  route_settings {
    route_key              = aws_apigatewayv2_route.webhook.route_key
    throttling_rate_limit  = 100
    throttling_burst_limit = 200
  }
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    # No Authorization header or query strings are logged.
    format = jsonencode({
      requestId = "$context.requestId"
      ip        = "$context.identity.sourceIp"
      method    = "$context.httpMethod"
      path      = "$context.path"
      status    = "$context.status"
      latency   = "$context.integrationLatency"
      authError = "$context.authorizer.error"
      sub       = "$context.authorizer.claims.sub"
    })
  }
  tags = var.tags
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.api_lambda.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

resource "aws_lambda_permission" "webhook" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = var.webhook_lambda.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

output "api_id" { value = aws_apigatewayv2_api.this.id }
output "api_endpoint" { value = aws_apigatewayv2_api.this.api_endpoint }
