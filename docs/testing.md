# Testing

| Suite | Command | What it covers | Status |
|---|---|---|---|
| Shared schemas | `npm test -w @lsp/shared` | validation, normalization, formatting | ✅ 10 passing |
| API on PostgreSQL | `npm run test:postgres -w @lsp/api` | the same suite against `PostgresStore` on PGlite (real Postgres in WASM), plus OIDC verifier, Resend mailer, standalone config guards, migrations, job leases, TTL purge | ✅ 89 passing |
| API unit/integration | `npm run test:memory -w @lsp/api` | authn/authz, events, invitations, tokens & grants (real LiveKit SDK signing), viewer permissions, speaker approval/demotion, concurrent approvals, capacity & 60-user join storm, recording authz, webhook signatures (real SDK), chat validation/rate limits, reconciliation, DynamoDB condition expressions | ✅ 85 passing |
| Browser E2E | `npm run test:e2e` | organizer creates event → invites → stranger blocked → invited viewer accepts → single-use link → waiting screen → studio blocked for viewers | ✅ 2 passing, 1 skipped without LiveKit |
| Live media E2E | same, with `LIVEKIT_URL/API_KEY/API_SECRET` exported for the API | broadcaster goes live with fake camera → viewer sees video → raise hand → approve → viewer gets mic controls | ⏳ needs LiveKit credentials |
| Admission load | `npx tsx tests/load/join-storm.ts --dev --users 60` | 60 concurrent join-token requests → exactly 50 admitted | ✅ PASS locally (49 viewers + host, p95 37 ms) |
| Media load | LiveKit CLI (below) | 50 real WebRTC participants | ⏳ needs LiveKit project |

In-memory store tests exercise the same conditional rules as DynamoDB; `test/dynamo.test.ts` asserts the exact condition expressions and cancellation-reason mapping sent to DynamoDB. A test against a real table (DynamoDB Local or a dev table) is recommended before production.

## 50-participant media load test (LiveKit CLI)

```bash
# Install: https://docs.livekit.io/home/cli/  (lk)
# 1. Start the event and go live from the Studio so the room exists.
# 2. Simulate 1 publisher + 49 subscribers in the same room
#    (`lk perf load-test` on current CLI versions; check `lk --help` for your version's flags):
lk perf load-test \
  --url wss://<project>.livekit.cloud --api-key <key> --api-secret <secret> \
  --room evt-<eventId> \
  --video-publishers 1 --audio-publishers 5 --subscribers 49 \
  --duration 5m
```

Watch: packet loss/jitter in the output, LiveKit Cloud dashboard (participants, bandwidth), and CloudWatch for the `webhook` Lambda. Note: the CLI mints its own tokens, so these synthetic participants bypass app admission and will be **removed by the webhook/reconciler** as unadmitted (by design). For the load test, either temporarily disable the LiveKit webhook or run against a room created outside the app; then separately run `join-storm.ts` against the deployed API with real Cognito ID tokens:

```bash
npx tsx tests/load/join-storm.ts --api https://<api> --event <id> --tokens tokens.json
```

## Mobile smoke test (development build on a physical device)

1. `cd apps/mobile && npx expo start --dev-client`, open the dev build (EAS `development` profile).
2. Sign in as an invited viewer → **My Events** lists the event (pull to refresh).
3. Event Details shows "Not live yet"; start the event from the web Studio → within 15 s "Join live event" appears.
4. Join → video plays, audio from loudspeaker; rotate to landscape → full-screen video with chat side panel.
5. Send chat + reactions; verify they appear on the web Studio.
6. Raise hand → approve in Studio → "You're on stage" alert → tap mic → Android/iOS permission prompt → host hears audio; toggle camera.
7. Host taps "Remove from stage" → mic/camera turn off, controls disappear.
8. Toggle airplane mode for 10 s → "Reconnecting…" then playback resumes.
9. Background the app (iOS) → audio continues; return → video resumes.
10. End event in Studio → "Event ended" screen.
11. Schedule an event 12 minutes ahead → reminder push arrives (requires EAS push credentials).
