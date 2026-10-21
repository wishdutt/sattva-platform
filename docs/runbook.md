# Security & operations runbook

## Security model

| Control | Where |
|---|---|
| HTTPS/WSS only | API Gateway (TLS), LiveKit Cloud (WSS), S3 bucket policy denies non-TLS, HSTS on web |
| Authentication | Cognito SRP; 12+ char passwords; optional TOTP MFA; email verification; token revocation enabled |
| JWT verification | API Gateway JWT authorizer **and** `aws-jwt-verify` in Lambda (`token_use=id`, issuer, audience = web+mobile clients) |
| Event-level authorization | `loadAccess` on every event route: active membership required (admins can read/manage but must be members to join media); non-members get 404 |
| Invitations | 256-bit random tokens, only SHA-256 stored, 72h expiry, single-use (conditional transaction), verified-email match, revocable |
| Media access | LiveKit tokens minted only after membership + status + capacity checks; 10-minute TTL; viewers: subscribe-only, `canPublishData=false`; no `roomAdmin` for anyone |
| Revocation of issued tokens | Membership removal → `removeParticipant`; demotion → `updateParticipant` (LiveKit unpublishes); end → `deleteRoom`; webhook + 2-min reconciler kick any identity without an active admission |
| Moderation | Only backend can promote/demote/kick; requests verified against moderator rights at call time |
| Chat integrity | Server-stamped identity/role; whitelist reactions; control chars stripped; 500-char limit |
| Rate limiting | API Gateway stage throttling (200 rps/400 burst; webhook 100/200) + per-user DynamoDB windows (chat, reactions, raise-hand, join-token, invites) |
| Secrets | Secrets Manager only; Lambdas read at runtime; Egress IAM user can only `PutObject` under `recordings/` |
| Recordings | Private bucket (public access blocked, BucketOwnerEnforced), SSE, presigned 15-minute GET URLs for members only, lifecycle retention |
| Least privilege IAM | Separate roles for api / webhook / jobs; table, prefix and secret ARNs scoped |
| Audit | `AUDIT#EVENT#{id}` items (365d) for invites, accepts, joins, approvals, demotions, removals, recordings, reconciliation |
| Redaction | Structured logger redacts keys matching token/secret/password/authorization and masks email local-parts; API access logs exclude headers and query strings |
| Web hardening | CSP (connect-src limited to API, LiveKit, Cognito), `frame-ancestors 'none'`, nosniff, Permissions-Policy, no `X-Powered-By` |
| Dev-only auth | `createDevVerifier` throws if `AWS_LAMBDA_FUNCTION_NAME` is set; Lambda wiring always uses Cognito |

## Routine operations

**Add an organizer:** `aws cognito-idp admin-add-user-to-group --group-name organizers …` (user re-signs-in).

**Remove a user from a live event immediately:** Organizer → event page → People → trash icon (membership REMOVED, participant kicked, pending invites revoked). Platform-wide: `aws cognito-idp admin-user-global-sign-out` + `admin-disable-user`; any LiveKit token they still hold expires within 10 minutes and the reconciler removes them from rooms when membership is gone.

**Force-end a stuck event:** call `POST /events/{id}/end` as the organizer, or delete the room in the LiveKit dashboard — `room_finished` webhook releases all sessions; the hourly cleanup job ends LIVE events 6h after their scheduled end.

**Capacity looks wrong (users told "full" incorrectly):** the reconciler rewrites `CAPACITY` from session items every 2 minutes; check logs for `capacity drift corrected`. Invoke manually: `aws lambda invoke --function-name lsp-prod-jobs --payload '{"job":"reconcile"}' out.json`.

**Recording failed:** Recording status `FAILED` with `error`. Check Egress logs in LiveKit Cloud; most common cause is the egress-s3 secret (wrong key/region) or the IAM user lacking `PutObject` on `recordings/*`.

**Rotate LiveKit keys:** create a new key in LiveKit Cloud → `put-secret-value` → wait 5 min (Lambda cache) → update the webhook signing key → delete the old key.

**Delete an event's data (GDPR request):** delete recordings via API (removes S3 objects), then query `PK = EVENT#{id}` and `PK = EVENT#{id}#CHAT` and batch-delete items; audit records expire via TTL.

## Alarms (SNS → `alarm_email`)

| Alarm | Meaning / first action |
|---|---|
| `*-errors` (Lambda ≥5 / 5 min) | Check CloudWatch Logs Insights: `fields @timestamp, msg, code, err.message | filter level="error"` |
| `*-throttles` | Account concurrency; raise limit or reserved concurrency |
| `*-api-5xx` / `*-api-p95-latency` | Correlate with Lambda errors and LiveKit status page |
| `*-dynamodb-throttles` | On-demand table hit partition limits; check for hot event during a join storm |
| `*-webhook-signature-failures` | Wrong webhook signing key **or** someone probing the endpoint |

## Known limitations

- An already-issued LiveKit token can reconnect until it expires (≤10 min) — the webhook/reconciler removes such participants if their membership/admission is gone; there is no token denylist in LiveKit itself.
- Mobile background **video** is not supported; background **audio** is configured on iOS (`UIBackgroundModes: audio`). Android background audio while publishing requires a foreground service, which is not implemented.
- Chat persistence uses a 100-message history window in the UI.
- Single region; for multi-region, use DynamoDB global tables and a LiveKit Cloud project per region.
