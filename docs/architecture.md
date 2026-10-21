# Architecture

```
 Browser (Next.js)          iOS / Android (Expo)
   │  Cognito SRP sign-in        │  Cognito SRP sign-in
   │  ID token (Bearer)          │  ID token (Bearer)
   ▼                             ▼
 API Gateway HTTP API ── JWT authorizer (Cognito issuer + web/mobile client audiences)
   │  ANY /api/v1/{proxy+}                    POST /api/v1/webhooks/livekit (no JWT)
   ▼                                          ▼
 Lambda "api"  (router + domain services)    Lambda "webhook" (LiveKit signature verification)
   │      │        │         │                      │
   │      │        │         └─ EventBridge bus ◄───┘ (domain events, 90-day archive)
   │      │        └─ SES (invitation email)
   │      └─ S3 (private: recordings/, thumbnails/) ← presigned URLs only
   └─ DynamoDB single table (+GSI1, GSI2, TTL)
   │
   └─ LiveKit Cloud server API (RoomService, Egress) ─── WebRTC media ───► clients
                                   │
                                   └─ Egress uploads MP4 to S3 recordings/ (scoped IAM user)

 EventBridge Scheduler → Lambda "jobs": reconcile (2 min), reminders (5 min, Expo push), cleanup (hourly)
```

## Key decisions

| Decision | Why |
|---|---|
| **Single "lambdalith" for REST** with an internal router; separate webhook + jobs Lambdas | One cold-start path for user traffic, but distinct IAM roles: the webhook can't send email or touch S3; jobs can't read recordings. |
| **Domain-level `Store` port** with `DynamoStore` and `MemoryStore` | Every invariant (single-use invitations, capacity, speaker slots, one open hand per user) is a single conditional write or transaction in DynamoDB, mirrored atomically in memory for tests and local dev. |
| **Server-relayed chat & reactions** (clients have `canPublishData=false`) | Sender identity, role, rate limits, persistence, and moderation are enforced on the server; clients only trust data packets with no sender participant (i.e. sent by the server API). |
| **Short-lived join tokens (10 min)** + server-side admission | Tokens are minted only after membership, event status and capacity checks. Because an issued token stays valid until expiry, revocation is enforced by `removeParticipant`, by `updateParticipant` (permissions), and by deleting the room at end — plus a webhook/reconciler that kicks anyone in the room without an active admission. |
| **Speaker promotion via `RoomService.updateParticipant`** | Permissions change live without reconnecting; revoking `canPublish` makes LiveKit unpublish the tracks server-side. The next token a speaker receives already reflects their current grant. |
| **Capacity counters + per-user session items** | `admitParticipant` is a transaction: the per-user session put (idempotent re-join) and a conditional counter increment. One slot is always reserved for the first host. LiveKit's own `maxParticipants` is set to the app limit + 2 (Egress recorder headroom) as a hard backstop. |
| **ID tokens (not access tokens) for the API** | The API needs verified `email`/`email_verified` (invitation matching) and `cognito:groups` (platform role). API Gateway validates `aud` against both app clients; the Lambda re-verifies with `aws-jwt-verify`. |
| **Secrets only in Secrets Manager**, created as empty containers by Terraform | LiveKit and Egress S3 credentials never touch Git, tfvars, or state. |
| **Mobile app installed separately from the npm workspace** | React Native pins an exact React version that differs from the web app's; Metro resolves `@lsp/shared` source via `watchFolders`. |

## Event lifecycle

`DRAFT → SCHEDULED → READY (backstage: room exists, hosts only) → LIVE → ENDED`, with `CANCELLED` reachable from DRAFT/SCHEDULED/READY.

- `POST /events/{id}/start {goLive:false}` creates the LiveKit room and enters READY.
- `POST /events/{id}/start` (default `goLive:true`) moves to LIVE and opens a `StreamSession`.
- `POST /events/{id}/end` stops recording, broadcasts `event_status`, deletes the room (disconnecting all tokens), releases all admissions and closes the session.
- The hourly cleanup job force-ends LIVE events 6h past their scheduled end.

## Moderated speaker workflow

1. Viewer `POST /raise-hand` → transaction creates `HAND#{user}` lock + `SPKREQ#{id}` (duplicates return the open request).
2. Backend sends `speaker_request` on topic `lsp.moderation` only to moderator identities.
3. Moderator `POST /speaker-requests/{id}/approve` → checks moderator rights, event LIVE, requester still admitted.
4. Transaction: request `PENDING→APPROVED` **and** `speakers < maxSpeakers` counter increment. Concurrent approvals for the last slot: exactly one wins (`SPEAKER_LIMIT` for the other).
5. `updateParticipant(canPublish, sources=[camera, microphone], metadata.speaker=true)`; if LiveKit fails, the slot is rolled back.
6. Viewer receives `ParticipantPermissionsChanged` + `speaker_approved` and may enable mic/camera.
7. Demote / leave / disconnect → transaction `APPROVED→REVOKED`, counter decrement, lock delete; `updateParticipant` revokes publish.

## Real-time data topics

| Topic | Messages | Audience |
|---|---|---|
| `lsp.chat` | `chat`, `chat_deleted` | everyone |
| `lsp.reaction` | `reaction` | everyone |
| `lsp.moderation` | `speaker_request`, `speaker_request_resolved` | moderators only (`destinationIdentities`) |
| `lsp.speaker` | `speaker_approved`, `speaker_revoked`, rejection notice | the affected user only |
| `lsp.system` | `event_status`, `recording`, `settings` | everyone |

## Multi-tenant SaaS path

Every record is already partitioned by event and owned by an organizer; adding a `tenantId` means prefixing partition keys (`T#{tenant}#EVENT#…`), a `custom:tenant` Cognito attribute checked in `loadAccess`, and per-tenant LiveKit projects (secret per tenant). The `Store` port keeps that change inside the persistence layer.
