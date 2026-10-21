variable "name" { type = string }
variable "web_callback_urls" {
  type    = list(string)
  default = []
}
variable "ses_from_email_arn" {
  type        = string
  default     = null
  description = "Optional SES identity ARN so Cognito sends verification/reset emails via SES (recommended in prod)."
}
variable "ses_from_address" {
  type    = string
  default = null
}
variable "deletion_protection" {
  type    = bool
  default = true
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_cognito_user_pool" "this" {
  name                     = var.name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = var.deletion_protection ? "ACTIVE" : "INACTIVE"
  mfa_configuration        = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 3
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Stagecast verification code"
    email_message        = "Your verification code is {####}"
  }

  dynamic "email_configuration" {
    for_each = var.ses_from_email_arn == null ? [] : [1]
    content {
      email_sending_account = "DEVELOPER"
      source_arn            = var.ses_from_email_arn
      from_email_address    = var.ses_from_address
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  tags = var.tags
}

locals {
  client_defaults = {
    explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
    prevent_user_existence_errors = "ENABLED"
    enable_token_revocation       = true
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name                          = "${var.name}-web"
  user_pool_id                  = aws_cognito_user_pool.this.id
  generate_secret               = false
  explicit_auth_flows           = local.client_defaults.explicit_auth_flows
  prevent_user_existence_errors = local.client_defaults.prevent_user_existence_errors
  enable_token_revocation       = local.client_defaults.enable_token_revocation
  id_token_validity             = 60
  access_token_validity         = 60
  refresh_token_validity        = 30
  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }
  read_attributes  = ["email", "email_verified", "name"]
  write_attributes = ["email", "name"]
}

resource "aws_cognito_user_pool_client" "mobile" {
  name                          = "${var.name}-mobile"
  user_pool_id                  = aws_cognito_user_pool.this.id
  generate_secret               = false
  explicit_auth_flows           = local.client_defaults.explicit_auth_flows
  prevent_user_existence_errors = local.client_defaults.prevent_user_existence_errors
  enable_token_revocation       = local.client_defaults.enable_token_revocation
  id_token_validity             = 60
  access_token_validity         = 60
  refresh_token_validity        = 90
  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }
  read_attributes  = ["email", "email_verified", "name"]
  write_attributes = ["email", "name"]
}

resource "aws_cognito_user_group" "admins" {
  name         = "platform-admins"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Platform administrators"
  precedence   = 1
}

resource "aws_cognito_user_group" "organizers" {
  name         = "organizers"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Users allowed to create events"
  precedence   = 10
}

output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "user_pool_arn" { value = aws_cognito_user_pool.this.arn }
output "web_client_id" { value = aws_cognito_user_pool_client.web.id }
output "mobile_client_id" { value = aws_cognito_user_pool_client.mobile.id }
output "issuer" { value = "https://${aws_cognito_user_pool.this.endpoint}" }
