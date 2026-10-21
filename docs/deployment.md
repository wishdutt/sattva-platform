# Deployment (AWS + LiveKit Cloud)

Nothing in this repository has been deployed yet. These are the exact steps; each requires credentials only you hold.

## 0. Prerequisites

- AWS account + CLI v2 configured with an admin (or deploy) role; Terraform ≥ 1.10 (tested with 1.16.6); Node 22+.
- A LiveKit Cloud project per environment (dev, prod): **Settings → Keys** for the API key/secret, and the project URL (`wss://<project>.livekit.cloud`).
- A domain you control for SES (DKIM records) and, for production, the web app.
- For mobile: an Expo account (`npx eas login`), Apple Developer account (iOS), Google Play Console (Android).

## 1. Remote state (once per account)

```bash
terraform -chdir=infrastructure/terraform/bootstrap init
terraform -chdir=infrastructure/terraform/bootstrap apply -var state_bucket_name=<unique-bucket-name>
```

Copy `envs/dev/backend.hcl.example` → `envs/dev/backend.hcl` and fill in the bucket and KMS key ARN from the outputs. State is encrypted with KMS, versioned, TLS-only, and locked with S3 native lock files (`use_lockfile = true`).

## 2. Build the Lambda bundles

```bash
npm ci
npm run build -w @lsp/api        # → services/api/dist/{api,webhook,jobs}/index.mjs
```

## 3. Apply the dev stack

```bash
cp infrastructure/terraform/envs/dev/terraform.tfvars.example infrastructure/terraform/envs/dev/terraform.tfvars   # edit values
terraform -chdir=infrastructure/terraform/envs/dev init -backend-config=backend.hcl
terraform -chdir=infrastructure/terraform/envs/dev apply
terraform -chdir=infrastructure/terraform/envs/dev output -json stack > stack-dev.json
```

## 4. Put secrets in Secrets Manager (never in Git/tfvars/state)

```bash
# LiveKit API credentials
aws secretsmanager put-secret-value --secret-id lsp/dev/livekit \
  --secret-string '{"apiKey":"APIxxxx","apiSecret":"xxxx"}'

# Egress upload key: an IAM user Terraform created with PutObject on recordings/* only
aws iam create-access-key --user-name lsp-dev-livekit-egress    # copy AccessKeyId / SecretAccessKey
aws secretsmanager put-secret-value --secret-id lsp/dev/egress-s3 \
  --secret-string '{"accessKey":"AKIA…","secret":"…"}'
```

Lambdas cache secrets for 5 minutes; rotate by writing a new value, then deleting the old access key after 10 minutes.

## 5. Configure LiveKit Cloud webhooks

LiveKit Cloud → **Settings → Webhooks** → add `stack.livekit_webhook_url` (`https://…/api/v1/webhooks/livekit`) signed with the **same API key** stored in the secret. Required for: connection tracking, speaker-slot release on disconnect, recording status.

## 6. SES

Publish the `stack.ses_dkim_records` CNAMEs, wait for the identity to verify, then request **production access** in the SES console (sandbox only delivers to verified addresses). In prod Cognito also sends verification/reset email through SES.

## 7. Bootstrap the first organizer / admin

```bash
POOL=$(jq -r .cognito_user_pool_id.value stack-dev.json)
# The user signs up in the web app first, then:
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username alice@example.com --group-name organizers
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username you@example.com  --group-name platform-admins
```

Group membership is embedded in the next ID token (sign out/in).

## 8. Web app

**Amplify Hosting (default):** set `amplify_repository` (+ `TF_VAR_amplify_github_token`) and re-apply, or connect the repo in the Amplify console using `infrastructure/terraform/modules/stack/amplify-buildspec.yml` with app root `apps/web` and these env vars:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `stack.api_url` |
| `NEXT_PUBLIC_AUTH_MODE` | `cognito` |
| `NEXT_PUBLIC_COGNITO_USER_POOL_ID` | `stack.cognito_user_pool_id` |
| `NEXT_PUBLIC_COGNITO_WEB_CLIENT_ID` | `stack.cognito_web_client_id` |
| `NEXT_PUBLIC_LIVEKIT_WS_ORIGIN` | your `wss://…livekit.cloud` URL (tightens CSP) |

Then set `web_base_url`/`web_origins` in tfvars to the Amplify domain and apply again (CORS + invitation links).

## 9. Mobile builds

```bash
cd apps/mobile
cp .env.example .env     # EXPO_PUBLIC_API_URL, Cognito pool + mobile client id, EAS_PROJECT_ID
npx eas init             # creates the EAS project id
npx eas build --profile development --platform ios       # dev client (needs Apple signing)
npx eas build --profile development --platform android
```

LiveKit's WebRTC module is native: **Expo Go cannot run this app**; use the development build. Push notifications require EAS credentials (APNs key / FCM v1 service account) configured with `npx eas credentials`.

## 10. Production

Repeat 3–9 with `envs/prod` (data protection, PITR, 90-day logs, SES-backed Cognito email). Use the `Deploy infrastructure` GitHub workflow with OIDC: create an IAM role trusting `token.actions.githubusercontent.com` for your repo/environment, and set repository variables `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`, `TF_BACKEND_HCL`, `TF_VARS`. Add required reviewers on the `prod` environment.

## Verification checklist (Definition of Done)

1. Organizer signs in, creates event. 2. Invites a viewer; email arrives. 3. Viewer signs up with that email, verifies, accepts. 4. Broadcaster opens Studio → Enable camera → Enter backstage → Go live. 5. Viewer joins on web; 6. and on iOS/Android dev build. 7. Viewer raises hand → 8. host approves → 9. viewer unmutes, host hears audio → 10. host removes from stage; mic stops. 11. A non-invited account gets 404 / cannot join. 12. 51st join attempt returns `EVENT_FULL`; 6th approval returns `SPEAKER_LIMIT`. 13. Organizer records, stops; replay plays from a 15-minute URL; the S3 object is not publicly reachable.
