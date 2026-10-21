variable "region" {
  type    = string
  default = "us-east-1"
}
variable "livekit_url" { type = string }
variable "web_base_url" { type = string }
variable "web_origins" { type = list(string) }
variable "ses_domain" { type = string }
variable "ses_from_address" { type = string }
variable "bucket_suffix" { type = string }
variable "alarm_email" {
  type    = string
  default = null
}
variable "amplify_repository" {
  type    = string
  default = null
}
variable "amplify_github_token" {
  type      = string
  default   = null
  sensitive = true
}
