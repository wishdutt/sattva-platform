# Stagecast — private interactive live events

Invitation-only live events: an organizer broadcasts from the browser, invited and authenticated participants watch on the web or iOS/Android, chat and react, raise their hand, and speak on stage when a moderator approves. Up to 50 participants per event, optional private recording and replay.

**Stack:** Next.js 16 + React 19 + Tailwind 4 · Expo SDK 58 / React Native 0.88 · LiveKit Cloud (WebRTC) · AWS Lambda (Node 22, TypeScript) · API Gateway HTTP API · Cognito · DynamoDB · S3 · SES · EventBridge · Secrets Manager · CloudWatch · Amplify Hosting · Terraform.

```
apps/web               Next.js app: dashboard, invitations, broadcaster Studio, viewer
apps/mobile            Expo app: login, my events, details, live + speaker mode, profile (separate npm install)
services/api           Lambda handlers (api, webhook, jobs), domain services, DynamoDB store, local dev server
packages/shared        Zod schemas, DTOs, typed API client, data-channel protocol (web + mobile + api)
packages/ui            Shared web UI components
infrastructure/terraform  bootstrap/, modules/*, envs/{dev,prod}
tests/e2e              Playwright browser tests      tests/load   admission load test
docs/                  architecture, database, openapi.yaml, deployment, testing, runbook
```

## Quick start (local, no cloud accounts needed)

Requires Node ≥ 20.18 (22 recommended).

```bash
npm install
npm run dev:api     # http://localhost:4000 — in-memory data, dev auth, MOCK LiveKit & email
npm run dev:web     # http://localhost:3000 — copy apps/web/.env.example to .env.local first
```

Sign in with any email (choose **Organizer**), create an event, invite `viewer@example.com`, then open `http://localhost:4000/dev/outbox` to grab the invitation link and accept it in another browser profile as that viewer.

**Real audio/video locally:** create a free LiveKit Cloud project and start the API with `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` set (see `services/api/.env.example`). Data stays in memory; media goes through LiveKit.

### What is mocked locally

| Concern | Local dev | Deployed |
|---|---|---|
| Auth | `dev:<email>[:organizer\|admin]` bearer tokens, refused inside Lambda | Cognito ID tokens (API Gateway authorizer + in-Lambda verification) |
| Data | `MemoryStore` (resets on restart) | `DynamoStore` |
| Email | captured at `/dev/outbox` | SES |
| LiveKit | mock (tokens are not valid for any server) unless `LIVEKIT_*` env set | LiveKit Cloud |
| Storage | fake URLs | private S3 + presigned URLs |

## Tests

```bash
npm test             # shared + API: 95 tests
npm run test:e2e     # Playwright (starts both servers)
npx tsx tests/load/join-storm.ts --dev --users 60   # with dev:api running
npm run lint && npm run typecheck
```

See [docs/testing.md](docs/testing.md) for coverage, the 50-participant LiveKit load test, and the mobile smoke test.

## Deploy

[docs/deployment.md](docs/deployment.md): bootstrap encrypted/locked remote state → `terraform apply` → write LiveKit + Egress credentials to Secrets Manager → register the LiveKit webhook → verify SES → add organizers to the Cognito group → Amplify Hosting → EAS builds.

## Docs

- [Architecture & key decisions](docs/architecture.md)
- [DynamoDB design & access patterns](docs/database.md)
- [OpenAPI spec](docs/openapi.yaml)
- [Security & operations runbook](docs/runbook.md)

## Status

| Area | State |
|---|---|
| API (events, invitations, membership, join tokens, capacity, speaker workflow, chat, reactions, recordings, webhooks, jobs) | Implemented; 85 API tests pass |
| Web app (auth, dashboard, event form, invites/people/recordings, Studio, viewer) | Implemented; builds; 2 E2E flows pass. Media flow not yet exercised against real LiveKit. |
| Mobile app (8 screens, LiveKit RN, speaker mode, push registration) | Implemented; typechecks and bundles (Metro). **Not yet run on a device** — needs an EAS dev build. |
| Terraform (dev/prod, 9 modules) | `terraform validate` passes. **Not yet applied** to an AWS account. |
| CI/CD | GitHub Actions for lint/typecheck/tests/E2E/mobile bundle/terraform validate; OIDC deploy workflow |
