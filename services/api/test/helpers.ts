import { createDevVerifier } from '../src/auth/verifier';
import type { AppDeps } from '../src/deps';
import { MemoryBus, MockStorage, OutboxMailer } from '../src/integrations/aws';
import { MockLiveKit, type LiveKitGateway } from '../src/integrations/livekit';
import { MemoryPush } from '../src/integrations/push';
import { buildRouter } from '../src/http/routes';
import { loadConfig } from '../src/lib/config';
import { silentLogger } from '../src/lib/logger';
import { MemoryStore } from '../src/store/memory';
import { PostgresStore, migrate } from '../src/store/postgres';
import { createPgliteDatabase, type SqlDatabase } from '../src/store/sql';
import type { Store } from '../src/store/types';

/**
 * TEST_STORE=postgres runs the whole suite against PostgresStore on PGlite (real Postgres in WASM).
 * One database per test file (vitest worker); tables are truncated for every new world.
 */
export const TEST_STORE = process.env.TEST_STORE === 'postgres' ? 'postgres' : 'memory';
let pgDb: Promise<SqlDatabase> | undefined;

async function freshStore(): Promise<Store> {
  if (TEST_STORE === 'memory') return new MemoryStore();
  pgDb ??= createPgliteDatabase().then(async (db) => {
    await migrate(db);
    return db;
  });
  const db = await pgDb;
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  await db.exec(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`);
  return new PostgresStore(db);
}

export const TOKENS = {
  admin: 'dev:admin@example.com:admin',
  organizer: 'dev:org@example.com:organizer',
  otherOrganizer: 'dev:org2@example.com:organizer',
  broadcaster: 'dev:host@example.com',
  viewer: 'dev:viewer@example.com',
  viewer2: 'dev:viewer2@example.com',
  viewer3: 'dev:viewer3@example.com',
  stranger: 'dev:stranger@example.com',
} as const;

export type TestWorld = Awaited<ReturnType<typeof createWorld>>;

export async function createWorld(opts: { livekit?: LiveKitGateway } = {}) {
  let nowMs = Date.parse('2026-11-01T16:00:00Z');
  const store = await freshStore();
  const livekit = (opts.livekit ?? new MockLiveKit()) as LiveKitGateway;
  const mailer = new OutboxMailer();
  const storage = new MockStorage();
  const bus = new MemoryBus();
  const push = new MemoryPush();
  const verifier = createDevVerifier();
  const deps: AppDeps = {
    config: { ...loadConfig({}), webBaseUrl: 'https://app.test' },
    store,
    livekit,
    mailer,
    storage,
    bus,
    push,
    verifier,
    logger: silentLogger,
    now: () => new Date(nowMs),
    egressCredentials: async () => ({ accessKey: 'AKIA_TEST', secret: 'secret' }),
  };
  const router = buildRouter();

  /** Calls the router like API Gateway would. `path` is relative to /api/v1 and may include a query string. */
  async function call<T = any>(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const url = new URL(`http://x/api/v1${path}`);
    const res = await router.handle(deps, {
      method,
      path: url.pathname,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      query: Object.fromEntries(url.searchParams),
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (res.body ? JSON.parse(res.body) : undefined) as T, headers: res.headers };
  }

  async function userId(token: string) {
    return (await verifier.verify(token)).userId;
  }

  /** Creates an event as `organizer` and returns its id. */
  async function createEvent(overrides: Record<string, unknown> = {}) {
    const res = await call('POST', '/events', TOKENS.organizer, {
      title: 'Town hall',
      startAt: '2026-11-01T17:00:00Z',
      durationMinutes: 60,
      timeZone: 'America/New_York',
      ...overrides,
    });
    if (res.status !== 201) throw new Error(`createEvent failed: ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  }

  /** Invites `token`'s email and accepts the invitation as that user. */
  async function addMember(eventId: string, token: string, role: 'VIEWER' | 'BROADCASTER' = 'VIEWER') {
    const email = token.split(':')[1]!;
    const inv = await call('POST', `/events/${eventId}/invitations`, TOKENS.organizer, { emails: [email], role });
    if (inv.status !== 201) throw new Error(`invite failed: ${JSON.stringify(inv.body)}`);
    const link = mailer.outbox.at(-1)!.text.match(/token=([\w-]+)/)![1]!;
    const acc = await call('POST', '/invitations/accept', token, { token: link });
    if (acc.status !== 200) throw new Error(`accept failed: ${JSON.stringify(acc.body)}`);
    return link;
  }

  async function goLive(eventId: string, token: string = TOKENS.organizer) {
    const res = await call('POST', `/events/${eventId}/start`, token, { goLive: true });
    if (res.status !== 200) throw new Error(`start failed: ${JSON.stringify(res.body)}`);
  }

  return {
    deps,
    store,
    livekit,
    mailer,
    storage,
    bus,
    call,
    userId,
    createEvent,
    addMember,
    goLive,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

/** Decodes a JWT payload without verifying (tests only). */
export function decodeJwt(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}
