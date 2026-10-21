# SES domain identity with DKIM for invitation emails. Publish the DKIM CNAMEs in your DNS
# (output `dkim_records`), then request SES production access to leave the sandbox.

variable "domain" { type = string }
variable "name" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain
  tags           = var.tags
}

resource "aws_sesv2_configuration_set" "this" {
  configuration_set_name = var.name
  reputation_options {
    reputation_metrics_enabled = true
  }
  sending_options {
    sending_enabled = true
  }
  suppression_options {
    suppressed_reasons = ["BOUNCE", "COMPLAINT"]
  }
  tags = var.tags
}

output "identity_arn" { value = aws_sesv2_email_identity.domain.arn }
output "configuration_set_name" { value = aws_sesv2_configuration_set.this.configuration_set_name }
output "configuration_set_arn" { value = aws_sesv2_configuration_set.this.arn }
output "dkim_records" {
  value = [for t in aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens : {
    name  = "${t}._domainkey.${var.domain}"
    type  = "CNAME"
    value = "${t}.dkim.amazonses.com"
  }]
}
