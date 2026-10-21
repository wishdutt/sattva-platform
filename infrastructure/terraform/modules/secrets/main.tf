# Secret *containers* only. Values are written out-of-band (see docs/deployment.md) so that
# LiveKit and S3 credentials never appear in Git, tfvars, or Terraform state.

variable "prefix" { type = string }
variable "media_bucket_arn" { type = string }
variable "recovery_window_days" {
  type    = number
  default = 7
}
variable "tags" {
  type    = map(string)
  default = {}
}

resource "aws_secretsmanager_secret" "livekit" {
  name                    = "${var.prefix}/livekit"
  description             = "LiveKit Cloud API key/secret: {\"apiKey\":\"...\",\"apiSecret\":\"...\"}"
  recovery_window_in_days = var.recovery_window_days
  tags                    = var.tags
}

resource "aws_secretsmanager_secret" "egress_s3" {
  name                    = "${var.prefix}/egress-s3"
  description             = "Access key for LiveKit Egress uploads: {\"accessKey\":\"...\",\"secret\":\"...\"}"
  recovery_window_in_days = var.recovery_window_days
  tags                    = var.tags
}

# IAM user used only by LiveKit Cloud Egress to upload recordings. It can write to recordings/ and nothing else.
# Create its access key manually (aws iam create-access-key) and store it in the egress-s3 secret.
resource "aws_iam_user" "egress" {
  name = "${replace(var.prefix, "/", "-")}-livekit-egress"
  tags = var.tags
}

resource "aws_iam_user_policy" "egress" {
  name = "recordings-upload-only"
  user = aws_iam_user.egress.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "UploadRecordings"
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"]
      Resource = "${var.media_bucket_arn}/recordings/*"
    }]
  })
}

output "livekit_secret_arn" { value = aws_secretsmanager_secret.livekit.arn }
output "egress_secret_arn" { value = aws_secretsmanager_secret.egress_s3.arn }
output "egress_iam_user" { value = aws_iam_user.egress.name }
