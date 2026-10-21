/**
 * Admission load test: N users request join tokens for the same live event at once and we verify
 * that exactly `maxParticipants` are admitted (server-authoritative capacity) and report latency.
 *
 * Local (dev auth, no Cognito):
 *   npx tsx tests/load/join-storm.ts --api http://localhost:4000 --users 60 --dev
 * Deployed (Cognito): provide a JSON file of ID tokens for invited test users:
 *   npx tsx tests/load/join-storm.ts --api https://xxx.execute-api.us-east-1.amazonaws.com --event <id> --tokens tokens.json
 *
 * Media load (50 real WebRTC participants) is tested with the LiveKit CLI — see docs/testing.md.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    api: { type: 'string', default: 'http://localhost:4000' },
    users: { type: 'string', default: '60' },
    event: { type: 'string' },
    tokens: { type: 'string' },
    dev: { type: 'boolean', default: false },
  },
});

const api = values.api!.replace(/\/$/, '') + '/api/v1';

async function call(token: string, method: string, path: string, body?: unknown) {
  const started = performance.now();
  const res = await fetch(api + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, ms: performance.now() - started };
}

async function setupDevEvent(userCount: number) {
  const organizer = `dev:loadtest-org-${Date.now()}@example.com:organizer`;
  const created = await call(organizer, 'POST', '/events', {
    title: 'Load test',
    startAt: new Date(Date.now() + 60_000).toISOString(),
    durationMinutes: 60,
    timeZone: 'UTC',
  });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const eventId = created.body.id as string;
  const users = Array.from({ length: userCount }, (_, i) => `loadtest-${Date.now()}-${i}@example.com`);
  for (let i = 0; i < users.length; i += 50) {
    const r = await call(organizer, 'POST', `/events/${eventId}/invitations`, { emails: users.slice(i, i + 50) });
    if (r.status !== 201) throw new Error(`invite failed: ${JSON.stringify(r.body)}`);
  }
  // Accept each invitation using the links captured by the local mock mailer.
  const outbox = (await (await fetch(values.api!.replace(/\/$/, '') + '/dev/outbox')).json()) as { to: string; text: string }[];
  for (const email of users) {
    const mail = outbox.find((m) => m.to === email)!;
    const token = /token=([\w-]+)/.exec(mail.text)![1];
    await call(`dev:${email}`, 'POST', '/invitations/accept', { token });
  }
  await call(organizer, 'POST', `/events/${eventId}/start`, { goLive: true });
  await call(organizer, 'POST', `/events/${eventId}/join-token`, {});
  return { eventId, tokens: users.map((u) => `dev:${u}`), max: created.body.maxParticipants as number, hostJoined: 1 };
}

const percentile = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

async function main() {
  let eventId: string;
  let tokens: string[];
  let expectedAdmits: number | undefined;
  if (values.dev) {
    const setup = await setupDevEvent(Number(values.users));
    eventId = setup.eventId;
    tokens = setup.tokens;
    expectedAdmits = Math.min(tokens.length, setup.max - setup.hostJoined);
  } else {
    if (!values.event || !values.tokens) throw new Error('--event and --tokens are required without --dev');
    eventId = values.event;
    tokens = JSON.parse(readFileSync(values.tokens, 'utf8')) as string[];
  }

  console.info(`Firing ${tokens.length} concurrent join-token requests at event ${eventId}…`);
  const results = await Promise.all(tokens.map((t) => call(t, 'POST', `/events/${eventId}/join-token`, {})));
  const admitted = results.filter((r) => r.status === 200).length;
  const full = results.filter((r) => r.status === 409 && r.body?.error?.code === 'EVENT_FULL').length;
  const other = results.filter((r) => r.status !== 200 && !(r.status === 409 && r.body?.error?.code === 'EVENT_FULL'));
  const latencies = results.map((r) => r.ms);

  console.info({ admitted, full, otherErrors: other.length, p50ms: Math.round(percentile(latencies, 50)), p95ms: Math.round(percentile(latencies, 95)) });
  if (other.length) console.error('Unexpected responses:', other.slice(0, 5).map((r) => ({ status: r.status, body: r.body })));
  if (expectedAdmits !== undefined && admitted !== expectedAdmits) {
    console.error(`FAIL: expected ${expectedAdmits} admissions, got ${admitted}`);
    process.exit(1);
  }
  console.info('PASS');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
