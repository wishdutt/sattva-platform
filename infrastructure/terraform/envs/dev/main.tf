terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.4" }
  }
  # Values come from backend.hcl (see backend.hcl.example): terraform init -backend-config=backend.hcl
  backend "s3" {}
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { ManagedBy = "terraform" }
  }
}

module "stack" {
  source                   = "../../modules/stack"
  environment              = "dev"
  livekit_url              = var.livekit_url
  web_base_url             = var.web_base_url
  web_origins              = var.web_origins
  ses_domain               = var.ses_domain
  ses_from_address         = var.ses_from_address
  bucket_suffix            = var.bucket_suffix
  protect_data             = false
  recording_retention_days = 30
  chat_retention_days      = 7
  log_retention_days       = 14
  alarm_email              = var.alarm_email
  amplify_repository       = var.amplify_repository
  amplify_github_token     = var.amplify_github_token
  amplify_branch           = "develop"
}
