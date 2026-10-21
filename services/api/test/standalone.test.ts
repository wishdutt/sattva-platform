import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createOidcVerifier } from '../src/auth/oidc';
import { ResendMailer } from '../src/integrations/mail';
import { createStandaloneDeps } from '../src/server/standalone';
import { PostgresStore, migrate } from '../src/store/postgres';
import { createPgliteDatabase } from '../src/store/sql';

const ISSUER = 'https://auth.example.test/realms/events';
const AUDIENCE = 'web-client';

async function oidcFixture() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const sign = (claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string; key?: CryptoKey } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.iss ?? ISSUER)
      .setAudience(opts.aud ?? AUDIENCE)
      .setSubject('user-123')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(opts.key ?? privateKey);
  return { keySet, sign };
}

describe('generic OIDC verifier', () => {
  it('accepts a valid token and maps claims (Keycloak-style nested roles)', async () => {
    const { keySet, sign } = await oidcFixture();
    const verifier = createOidcVerifier(
      { issuer: ISSUER, audiences: [AUDIENCE, 'mobile-client'], groupsClaim: 'realm_access.roles' },
      keySet,
    );
    const user = await verifier.verify(
      await sign({ email: 'Ana@Example.com', email_verified: true, name: 'Ana', realm_access: { roles: ['organizers'] } }),
    );
    expect(user).toMatchObject({
      userId: 'user-123',
      email: 'ana@example.com',
      emailVerified: true,
      displayName: 'Ana',
      platformRole: 'ORGANIZER',
    });
  });

  it('rejects wrong issuer, wrong audience, expired tokens and foreign signatures', async () => {
    const { keySet, sign } = await oidcFixture();
    const verifier = createOidcVerifier({ issuer: ISSUER, audiences: [AUDIENCE] }, keySet);
    const claims = { email: 'a@example.com', email_verified: true };
    await expect(verifier.verify(await sign(claims, { iss: 'https://evil.test' }))).rejects.toMatchObject({ status: 401 });
    await expect(verifier.verify(await sign(claims, { aud: 'other-app' }))).rejects.toMatchObject({ status: 401 });
    await expect(verifier.verify(await sign(claims, { exp: '-5m' }))).rejects.toMatchObject({ status: 401 });
    const attacker = await generateKeyPair('RS256');
    await expect(verifier.verify(await sign(claims, { key: attacker.privateKey }))).rejects.toMatchObject({ status: 401 });
  });

  it('treats missing email_verified as unverified unless explicitly trusted', async () => {
    const { keySet, sign } = await oidcFixture();
    const token = await sign({ email: 'a@example.com' });
    const strict = createOidcVerifier({ issuer: ISSUER, audiences: [AUDIENCE] }, keySet);
    expect((await strict.verify(token)).emailVerified).toBe(false);
    const trusting = createOidcVerifier({ issuer: ISSUER, audiences: [AUDIENCE], requireEmailVerified: false }, keySet);
    expect((await trusting.verify(token)).emailVerified).toBe(true);
    // An explicit false is never overridden.
    expect((await trusting.verify(await sign({ email: 'a@example.com', email_verified: false }))).emailVerified).toBe(false);
  });

  it('supports custom admin/organizer group names', async () => {
    const { keySet, sign } = await oidcFixture();
    const verifier = createOidcVerifier(
      { issuer: ISSUER, audiences: [AUDIENCE], groupsClaim: 'roles', adminGroup: 'events-admin', organizerGroup: 'events-host' },
      keySet,
    );
    expect((await verifier.verify(await sign({ email: 'a@x.com', email_verified: true, roles: ['events-admin'] }))).platformRole).toBe('ADMIN');
  });
});

describe('Resend mailer', () => {
  it('posts to the Resend API and surfaces failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"id":"1"}', { status: 200 }));
    const mailer = new ResendMailer('Events <events@example.com>', 're_test', fetchMock as unknown as typeof fetch);
    await mailer.send({ to: 'a@example.com', subject: 'Hi', text: 't', html: '<p>t</p>' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test');
    expect(JSON.parse(init.body)).toMatchObject({ to: ['a@example.com'], subject: 'Hi' });

    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 422 }));
    await expect(mailer.send({ to: 'a@example.com', subject: 'Hi', text: 't', html: 't' })).rejects.toThrow(/422/);
  });
});

describe('standalone configuration', () => {
  it('refuses dev/mock adapters in production and lists every problem', async () => {
    await expect(
      createStandaloneDeps({ NODE_ENV: 'production', STORE: 'memory', AUTH_MODE: 'dev' }),
    ).rejects.toThrow(/STORE=memory[\s\S]*AUTH_MODE=dev[\s\S]*LIVEKIT[\s\S]*S3_BUCKET[\s\S]*MAIL_PROVIDER/);
  });

  it('requires OIDC settings for AUTH_MODE=oidc', async () => {
    await expect(createStandaloneDeps({ STORE: 'memory', AUTH_MODE: 'oidc' })).rejects.toThrow(/OIDC_ISSUER/);
  });

  it('builds a working dev runtime on PGlite with migrations applied', async () => {
    const runtime = await createStandaloneDeps({ STORE: 'pglite', AUTH_MODE: 'dev', CORS_ORIGINS: 'http://a.test,http://b.test' });
    try {
      expect(runtime.modes).toMatchObject({ store: 'pglite', auth: 'dev', livekit: 'mock', mail: 'outbox', storage: 'mock' });
      expect(runtime.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
      const { rows } = await runtime.db!.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version');
      expect(rows.map((r) => Number(r.version))).toEqual([1, 2]);
    } finally {
      await runtime.db?.close();
    }
  });
});

describe('PostgresStore specifics', () => {
  it('migrations are idempotent and job leases are exclusive until expiry', async () => {
    const db = await createPgliteDatabase();
    try {
      await migrate(db);
      await migrate(db);
      const store = new PostgresStore(db);
      expect(await store.tryAcquireLease('job:reconcile', 'node-a', 60)).toBe(true);
      expect(await store.tryAcquireLease('job:reconcile', 'node-b', 60)).toBe(false);
      expect(await store.tryAcquireLease('job:reconcile', 'node-a', 60)).toBe(true); // owner renews
      await db.query(`UPDATE job_leases SET locked_until = now() - interval '1 second'`);
      expect(await store.tryAcquireLease('job:reconcile', 'node-b', 60)).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('purges expired rows (TTL replacement)', async () => {
    const db = await createPgliteDatabase();
    try {
      await migrate(db);
      const store = new PostgresStore(db);
      await store.hitRateLimit('chat#x', 5, 10, Date.parse('2020-01-01T00:00:00Z'));
      expect(await store.purgeExpired()).toBe(1);
    } finally {
      await db.close();
    }
  });
});
