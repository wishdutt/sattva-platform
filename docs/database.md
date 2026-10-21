# DynamoDB single-table design

Table `lsp-{env}-main` — on-demand, PITR (prod), SSE, deletion protection (prod), streams enabled.
Keys: `PK`, `SK`; `GSI1` (`GSI1PK`, `GSI1SK`); `GSI2` (`GSI2PK`, `GSI2SK`); TTL attribute `ttl` (epoch seconds).
Implementation: [`services/api/src/store/keys.ts`](../services/api/src/store/keys.ts), [`dynamo.ts`](../services/api/src/store/dynamo.ts).

## Entities

| Entity | PK | SK | GSI1PK / GSI1SK | GSI2PK / GSI2SK | TTL | Notes |
|---|---|---|---|---|---|---|
| User profile | `USER#{sub}` | `PROFILE` | `EMAIL#{email}` / `USER` | – | – | Upserted from verified ID-token claims on `GET /me`. |
| Push device | `USER#{sub}` | `DEVICE#{sha256(token)}` | – | – | – | Expo push tokens. |
| Event | `EVENT#{id}` | `META` | `ORG#{organizerId}` / `{startAt}#{id}` | `STATUS#{status}` / `{startAt}#{id}` | – | `version` incremented on every update; `activeRecordingId` guards a single recording. |
| Event member | `EVENT#{id}` | `MEMBER#{sub}` | `MEMBER#{sub}` / `{startAt}#{eventId}` | – | – | `role` ORGANIZER/BROADCASTER/VIEWER, `status` ACTIVE/REMOVED, `canModerate`. |
| Invitation | `EVENT#{id}` | `INVITE#{id}` | – | `INVTOKEN#{sha256(token)}` / `INVITE` | expiresAt + 30d | Raw token is never stored. |
| Capacity counters | `EVENT#{id}` | `CAPACITY` | – | – | – | `total`, `hosts`, `speakers`. |
| Participant session | `EVENT#{id}` | `PSESSION#{sub}` | – | – | admittedAt + 90d | `ADMITTED → CONNECTED → LEFT`, `livekitSid`. |
| Speaker request | `EVENT#{id}` | `SPKREQ#{id}` | – | – | – | PENDING/APPROVED/REJECTED/CANCELLED/REVOKED. |
| Hand lock | `EVENT#{id}` | `HAND#{sub}` | – | – | – | `{requestId}`; exists while a request is PENDING or APPROVED. |
| Stream session | `EVENT#{id}` | `STREAM#{id}` | – | – | – | One per go-live; `peakParticipants`. |
| Chat message | `EVENT#{id}#CHAT` | `MSG#{timeSortableId}` | – | – | createdAt + chat retention | Soft-deleted by moderators (text cleared). |
| Recording | `EVENT#{id}` | `REC#{id}` | – | `EGRESS#{egressId}` / `REC` | – | S3 object deleted on delete; lifecycle rule enforces retention. |
| Audit event | `AUDIT#{scope}` | `{at}#{id}` | – | – | at + audit retention (365d) | scope = `EVENT#{id}`. |
| Rate-limit window | `RATE#{name}#{subject}#{window}` | `RATE` | – | – | window end + 1 window | Fixed-window counters. |
| Idempotency record | `IDEM#{user}#{method}#{path}#{key}` | `IDEM` | – | – | 24h | Replays the first response for `Idempotency-Key`. |

## Access patterns (no scans)

| Pattern | Operation |
|---|---|
| Get event / member / capacity / session | `GetItem` (strongly consistent) |
| Members, invitations, speaker requests, recordings, sessions of an event | `Query PK=EVENT#{id} begins_with(SK, prefix)` |
| "My events" (any role) | `Query GSI1 MEMBER#{sub}` → `BatchGetItem` events |
| Organizer's events | `Query GSI1 ORG#{sub}` |
| Admin dashboard, reconciliation, reminders | `Query GSI2 STATUS#{status}` (one query per status) |
| Invitation by link token | `Query GSI2 INVTOKEN#{hash}` → strongly consistent `GetItem` on base item |
| Recording by egress id (webhook) | `Query GSI2 EGRESS#{egressId}` |
| Chat history | `Query PK=EVENT#{id}#CHAT ScanIndexForward=false Limit=100` |
| Audit log | `Query PK=AUDIT#EVENT#{id}` |

## Conditional writes & transactions

| Invariant | Mechanism |
|---|---|
| Event created once | `Put … attribute_not_exists(PK)` in a transaction with organizer member + capacity item |
| Status transitions | `Update … #status IN (:allowed…)` |
| Invitation single-use & unexpired | Transaction: `Update INVITE #status = PENDING AND expiresAt > :now` + `Put MEMBER` |
| Capacity (≤ max, host slot reserved) | Transaction: `Put PSESSION (attribute_not_exists OR state = LEFT)` + `Update CAPACITY ADD total` with condition `(hosts = 0 AND total < max-1) OR (hosts > 0 AND total < max)` (viewers) / `total < max OR hosts = 0` (hosts) |
| Release slot once | Transaction: `Update PSESSION state <> LEFT` + `ADD total -1` (`total > 0`) |
| One open hand per user | Transaction: `Put HAND attribute_not_exists` + `Put SPKREQ` |
| Speaker limit under concurrency | Transaction: `Update SPKREQ status = PENDING` + `ADD speakers 1` (`speakers < max`) |
| One active recording | Transaction: `Update META activeRecordingId` absent/null + `Put REC` |

Counters can drift only if a process dies between LiveKit and DynamoDB side effects; the reconciler recomputes `total/hosts/speakers` from session and request items every 2 minutes.

## Retention

| Data | Retention |
|---|---|
| Chat | `CHAT_RETENTION_DAYS` (prod 30, dev 7) via TTL |
| Audit | 365 days via TTL |
| Invitations | 30 days after expiry via TTL |
| Participant sessions | 90 days via TTL |
| Recordings | S3 lifecycle `recording_retention_days` (prod 365) + manual delete |
| Events / members | Kept; deleting an event's data is a manual admin operation (see runbook) |

Sample items: [`sample-data.json`](sample-data.json).
