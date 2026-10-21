import { describe, expect, it } from 'vitest';
import { LiveKitCloudGateway, MockLiveKit, type TokenRequest } from '../src/integrations/livekit';
import { TOKENS, createWorld, decodeJwt } from './helpers';

/** Mocks room APIs (no network) but signs tokens with the real LiveKit SDK. */
class RealTokenLiveKit extends MockLiveKit {
  private readonly real = new LiveKitCloudGateway('wss://example.livekit.cloud', 'APItestkey', 'test-secret-'.padEnd(40, 'x'));
  override readonly serverUrl = 'wss://example.livekit.cloud';
  override async createToken(req: TokenRequest) {
    return this.real.createToken(req);
  }
}
const realLiveKit = () => new RealTokenLiveKit();

describe('join tokens', () => {
  it('viewers receive subscribe-only grants with a short expiry', async () => {
    const w = createWorld({ livekit: realLiveKit() });
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.viewer);
    await w.goLive(id);

    const res = await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ serverUrl: 'wss://example.livekit.cloud', role: 'VIEWER', canPublish: false });
    const claims = decodeJwt(res.body.token);
    expect(claims.sub).toBe(await w.userId(TOKENS.viewer));
    expect(claims.video).toMatchObject({
      room: `evt-${id}`,
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
    });
    expect(claims.video.roomAdmin).toBeFalsy();
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(600);
    expect(JSON.parse(claims.metadata)).toMatchObject({ role: 'VIEWER', speaker: false });
  });

  it('hosts receive publish grants including screen share', async () => {
    const w = createWorld({ livekit: realLiveKit() });
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.broadcaster, 'BROADCASTER');
    await w.call('POST', `/events/${id}/start`, TOKENS.organizer, { goLive: false });
    const res = await w.call('POST', `/events/${id}/join-token`, TOKENS.broadcaster, {});
    const { video } = decodeJwt(res.body.token);
    expect(video.canPublish).toBe(true);
    expect(video.canPublishSources).toEqual(['camera', 'microphone', 'screen_share', 'screen_share_audio']);
    expect(video.canPublishData).toBe(false);
  });

  it('viewers wait until the event is live; hosts may join backstage', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.viewer);
    const early = await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {});
    expect(early.status).toBe(409);
    expect(early.body.error).toMatchObject({ code: 'EVENT_NOT_LIVE', details: { status: 'SCHEDULED' } });
    await w.call('POST', `/events/${id}/start`, TOKENS.organizer, { goLive: false });
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {})).status).toBe(409);
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.organizer, {})).status).toBe(200);
  });

  it('unauthorized users cannot obtain tokens', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.goLive(id);
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.stranger, {})).status).toBe(404);
    expect((await w.call('POST', `/events/${id}/join-token`, null, {})).status).toBe(401);
    // Platform admins must still be members to join media.
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.admin, {})).status).toBe(403);
  });

  it('rate limits token requests', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.goLive(id);
    const results = [];
    for (let i = 0; i < 21; i++) results.push((await w.call('POST', `/events/${id}/join-token`, TOKENS.organizer, {})).status);
    expect(results.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(results[20]).toBe(429);
  });
});

describe('capacity', () => {
  it('reserves a slot for the host and rejects viewers beyond the limit', async () => {
    const w = createWorld();
    const id = await w.createEvent({ maxParticipants: 3 });
    for (const t of [TOKENS.viewer, TOKENS.viewer2, TOKENS.viewer3]) await w.addMember(id, t);
    await w.goLive(id);

    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {})).status).toBe(200);
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer2, {})).status).toBe(200);
    // Third viewer would consume the slot reserved for the first host.
    const full = await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer3, {});
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('EVENT_FULL');
    // The organizer still gets in.
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.organizer, {})).status).toBe(200);
    expect(await w.store.getCapacity(id)).toMatchObject({ total: 3, hosts: 1 });
  });

  it('re-issuing a token to an admitted user does not consume another slot', async () => {
    const w = createWorld();
    const id = await w.createEvent({ maxParticipants: 2 });
    await w.addMember(id, TOKENS.viewer);
    await w.goLive(id);
    for (let i = 0; i < 3; i++) expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {})).status).toBe(200);
    expect((await w.store.getCapacity(id)).total).toBe(1);
  });

  it('leaving frees the slot', async () => {
    const w = createWorld();
    const id = await w.createEvent({ maxParticipants: 2 });
    await w.addMember(id, TOKENS.viewer);
    await w.addMember(id, TOKENS.viewer2);
    await w.goLive(id);
    await w.call('POST', `/events/${id}/join-token`, TOKENS.organizer, {});
    await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {});
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer2, {})).status).toBe(409);
    expect((await w.call('POST', `/events/${id}/leave`, TOKENS.viewer, {})).status).toBe(204);
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer2, {})).status).toBe(200);
  });

  it('admits exactly the limit under a concurrent join storm of 50+ users', async () => {
    const w = createWorld();
    const id = await w.createEvent({ maxParticipants: 50 });
    const tokens = Array.from({ length: 60 }, (_, i) => `dev:user${i}@example.com`);
    for (const t of tokens) await w.addMember(id, t);
    await w.goLive(id);
    await w.call('POST', `/events/${id}/join-token`, TOKENS.organizer, {});
    const results = await Promise.all(tokens.map((t) => w.call('POST', `/events/${id}/join-token`, t, {})));
    expect(results.filter((r) => r.status === 200)).toHaveLength(49);
    expect(results.filter((r) => r.status === 409)).toHaveLength(11);
    expect((await w.store.getCapacity(id)).total).toBe(50);
  });
});
