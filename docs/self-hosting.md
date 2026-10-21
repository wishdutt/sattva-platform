# Self-hosting without AWS

The platform runs in two interchangeable shapes. Domain logic, tests, web and mobile apps are shared; only adapters differ.

| Concern | AWS deployment | Standalone deployment |
|---|---|---|
| API runtime | Lambda + API Gateway | One Node process / container (`services/api/src/server/main.ts`) |
| Data | DynamoDB (`DynamoStore`) | PostgreSQL ≥ 14 (`PostgresStore`) |
| Auth | Cognito | Any OpenID Connect provider (Keycloak, Auth0, Zitadel, Authentik, Okta, Logto…) or Cognito |
| Object storage | S3 | Any S3-compatible service (Cloudflare R2, MinIO, Backblaze B2, Wasabi) or S3 |
| Email | SES | SMTP, Resend, or SES |
| Scheduled jobs | EventBridge Scheduler → Lambda | In-process scheduler with a Postgres lease (one replica runs each job) |
| Domain events | EventBridge | Logged (hook a queue/webhook into `LogBus` if needed) |
| Secrets | Secrets Manager | Your host's secret store / environment variables |
| TTL cleanup | DynamoDB TTL | `cleanup` job deletes expired chat/audit/rate-limit/idempotency rows |
| Web hosting | Amplify | Docker image (`apps/web/Dockerfile`), Vercel, Netlify, Cloudflare |
| Real-time media | LiveKit Cloud | LiveKit Cloud **or** self-hosted LiveKit server |

## Try it locally (everything self-hosted)

Requires Docker Desktop.

```bash
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:3000 | Web app — "Continue with Stagecast account" redirects to Keycloak |
| http://localhost:8080 | Keycloak (admin / admin) — realm `stagecast` is pre-imported |
| http://localhost:8025 | Mailpit — invitation and verification emails land here |
| http://localhost:9001 | MinIO console (minioadmin / minioadmin) |
| http://localhost:4000/ready | API readiness (checks Postgres) |

Demo accounts (local realm only): `organizer@example.com` / `LocalDev#Organizer1` (in the *organizers* group) and `viewer@example.com` / `LocalDev#Viewer1`. Invite the viewer from the organizer account, open the link from Mailpit in a private window, sign in as the viewer, accept, then go live from the Studio.

Not included in compose: **LiveKit Egress** (recording). Starting a recording returns a clear error locally; use LiveKit Cloud or deploy Egress separately (it needs Redis and a headless Chrome worker).

## Production checklist

1. **Postgres** — managed (Neon, Supabase, RDS, Cloud SQL, Crunchy) with TLS (`DATABASE_SSL=true`), daily backups + PITR. Migrations run on start (`MIGRATE_ON_START=true`) or as a release step (`node migrate/index.mjs`).
2. **Identity provider** — create two **public** clients with Authorization Code + **PKCE (S256)**:
   - web: redirect URIs `https://<web>/auth/callback`, `https://<web>/auth/silent`; post-logout `https://<web>/login`; web origin `https://<web>`.
   - mobile: redirect URI `stagecast://auth`; enable refresh tokens (`offline_access`).
   - Put `email`, `email_verified`, `name` and a groups/roles claim in the **ID token**. Create groups for organizers and admins (names configurable via `OIDC_ORGANIZER_GROUP` / `OIDC_ADMIN_GROUP`).
   - Require email verification. Invitations are matched to the token's verified email — this is a security boundary.
3. **Storage** — create a private bucket (no public access). Configure CORS on the bucket for your web origin (`GET`, `PUT`, header `content-type`). Add a lifecycle rule expiring `recordings/` after your retention period. For recordings, issue a separate key that can only write `recordings/*` and set `EGRESS_S3_*`.
4. **Email** — Resend (`MAIL_PROVIDER=resend`) or any SMTP relay; verify your sending domain (SPF/DKIM).
5. **LiveKit** — LiveKit Cloud (simplest) or self-hosted (`livekit-server` with TURN/TLS, see LiveKit's deployment docs). Register the webhook `https://<api>/api/v1/webhooks/livekit` signed with the same API key.
6. **API** — run `services/api/Dockerfile` (≥ 2 replicas behind a TLS load balancer is fine; jobs are leased). Configure from `services/api/.env.standalone.example`. Health: `/health` (liveness), `/ready` (readiness, checks the DB).
7. **Web** — build `apps/web/Dockerfile` with `NEXT_PUBLIC_*` build args for that environment (they are compiled in), or deploy `apps/web` to Vercel/Netlify with the same env vars. Set `NEXT_PUBLIC_MEDIA_ORIGIN` to your storage origin and `NEXT_PUBLIC_LIVEKIT_WS_ORIGIN` to your LiveKit URL (tightens the CSP).
8. **Mobile** — set `EXPO_PUBLIC_AUTH_MODE=oidc`, `EXPO_PUBLIC_OIDC_ISSUER`, `EXPO_PUBLIC_OIDC_CLIENT_ID`, and build with EAS as usual.

## Example low-cost stack

| Piece | Service |
|---|---|
| API container | Render / Fly.io / Railway (1–2 small instances) |
| Postgres | Neon or Supabase |
| Storage | Cloudflare R2 (no egress fees) |
| Email | Resend |
| Auth | Keycloak on the same host, or Auth0/Zitadel Cloud |
| Web | Vercel, or the web Docker image |
| Media | LiveKit Cloud |

## How correctness is preserved

`PostgresStore` implements the same `Store` interface as DynamoDB. Per-event invariants (capacity, the reserved host slot, speaker limit) lock the event's `capacity` row with `SELECT … FOR UPDATE`. Invitations are accepted with a conditional `UPDATE … WHERE status = 'PENDING' AND expires_at > now`. The "one open raised hand per user" rule is a partial unique index. The full API test suite (89 tests, including the 60-user join storm and concurrent approvals) runs against PostgresStore on PGlite in CI via `npm run test:postgres -w @lsp/api`. PGlite is a single connection, so those tests prove the logic, not multi-connection locking; run `tests/load/join-storm.ts` against a real Postgres-backed deployment before going live.
