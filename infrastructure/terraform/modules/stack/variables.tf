variable "environment" {
  type = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod"
  }
}
variable "livekit_url" {
  type        = string
  description = "LiveKit Cloud project URL, e.g. wss://my-project.livekit.cloud (not secret)."
}
variable "web_base_url" {
  type        = string
  description = "Public web origin used in invitation links, e.g. https://events.example.com"
}
variable "web_origins" {
  type        = list(string)
  description = "Origins allowed by API CORS and the media bucket CORS."
}
variable "ses_domain" { type = string }
variable "ses_from_address" { type = string }
variable "cognito_email_via_ses" {
  type    = bool
  default = false
}
variable "bucket_suffix" {
  type        = string
  description = "Makes the media bucket name globally unique (e.g. your account id)."
}
variable "protect_data" {
  type    = bool
  default = true
}
variable "recording_retention_days" {
  type    = number
  default = 365
}
variable "chat_retention_days" {
  type    = number
  default = 30
}
variable "log_retention_days" {
  type    = number
  default = 30
}
variable "alarm_email" {
  type    = string
  default = null
}
variable "amplify_repository" {
  type        = string
  default     = null
  description = "GitHub repository URL for Amplify Hosting. Leave null to host the web app elsewhere."
}
variable "amplify_github_token" {
  type      = string
  default   = null
  sensitive = true
}
variable "amplify_branch" {
  type    = string
  default = "main"
}
variable "tags" {
  type    = map(string)
  default = {}
}
