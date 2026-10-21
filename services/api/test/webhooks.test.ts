import { createHash } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import { LiveKitCloudGateway, type MockLiveKit } from '../src/integrations/livekit';
import { handleLiveKitWebhook } from '../src/services/webhooks';
import { TOKENS, createWorld } from './helpers';

const API_KEY = 'APIwebhooktest';
const API_SECRET = 'webhook-secret-'.padEnd(40, 'z');

async function sign(body: string, secret = API_SECRET) {
  const at = new AccessToken(API_KEY, secret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  return at.toJwt();
}

const body = JSON.stringify({
  event: 'participant_left',
  id: 'EV_test',
  createdAt: '1700000000',
  room: { name: 'evt-abc' },
  participant: { identity: 'user-1', sid: 'PA_1' },
});

describe('LiveKit webhook signature verification (real SDK)', () => {
  const gateway = new LiveKitCloudGateway('wss://example.livekit.cloud', API_KEY, API_SECRET);

  it('accepts a correctly signed body', async () => {
    const evt = await gateway.verifyWebhook(body, await sign(body));
    expect(evt).toMatchObject({ event: 'participant_left', roomName: 'evt-abc', participantIdentity: 'user-1' });
  });

  it('rejects a tampered body', async () => {
    const signature = await sign(body);
    await expect(gateway.verifyWebhook(body.replace('user-1', 'user-2'), signature)).rejects.toThrow();
  });

  it('rejects a signature made with another secret', async () => {
    await expect(gateway.verifyWebhook(body, await sign(body, 'other-secret-'.padEnd(40, 'q')))).rejects.toThrow();
  });

  it('rejects a missing authorization header', async () => {
    await expect(gateway.verifyWebhook(body, undefined)).rejects.toThrow();
  });

  it('the handler answers 401 without touching state when verification fails', async () => {
    const w = createWorld({ livekit: gateway });
    await expect(handleLiveKitWebhook(w.deps, body, 'garbage')).rejects.toMatchObject({ status: 401 });
  });
});

describe('webhook event handling', () => {
  const hook = (event: string, roomName: string, identity: string, sid = 'PA_1') =>
    JSON.stringify({ event, id: `EV_${Math.random()}`, createdAt: 0, roomName, participantIdentity: identity, participantSid: sid });

  it('participant_left releases capacity and the speaker slot (idempotently)', async () => {
    const w = createWorld();
    const id = await w.createEvent({ maxSpeakers: 1 });
    await w.addMember(id, TOKENS.viewer);
    await w.goLive(id);
    await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {});
    const req = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    await w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.organizer, {});
    const viewerId = await w.userId(TOKENS.viewer);

    await handleLiveKitWebhook(w.deps, hook('participant_joined', `evt-${id}`, viewerId), 'mock-signature');
    expect((await w.store.getParticipantSession(id, viewerId))?.state).toBe('CONNECTED');

    const left = hook('participant_left', `evt-${id}`, viewerId);
    await handleLiveKitWebhook(w.deps, left, 'mock-signature');
    await handleLiveKitWebhook(w.deps, left, 'mock-signature'); // duplicate delivery
    expect(await w.store.getCapacity(id)).toMatchObject({ total: 0, speakers: 0 });
  });

  it('removes participants who join without an admission or membership', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.goLive(id);
    await handleLiveKitWebhook(w.deps, hook('participant_joined', `evt-${id}`, 'intruder'), 'mock-signature');
    const lk = w.livekit as MockLiveKit;
    expect(lk.callsTo('removeParticipant').map((c) => c.args[1])).toContain('intruder');
  });

  it('re-admits a member whose reconnect arrives after their "left" webhook', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.viewer);
    await w.goLive(id);
    await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {});
    const viewerId = await w.userId(TOKENS.viewer);
    await handleLiveKitWebhook(w.deps, hook('participant_joined', `evt-${id}`, viewerId, 'PA_1'), 'mock-signature');
    await handleLiveKitWebhook(w.deps, hook('participant_left', `evt-${id}`, viewerId, 'PA_1'), 'mock-signature');
    await handleLiveKitWebhook(w.deps, hook('participant_joined', `evt-${id}`, viewerId, 'PA_2'), 'mock-signature');
    expect((await w.store.getParticipantSession(id, viewerId))?.state).toBe('CONNECTED');
    expect((w.livekit as MockLiveKit).callsTo('removeParticipant')).toHaveLength(0);
    expect((await w.store.getCapacity(id)).total).toBe(1);
  });

  it('ignores a stale "left" for an older connection', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.viewer);
    await w.goLive(id);
    await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {});
    const viewerId = await w.userId(TOKENS.viewer);
    await handleLiveKitWebhook(w.deps, hook('participant_joined', `evt-${id}`, viewerId, 'PA_new'), 'mock-signature');
    await handleLiveKitWebhook(w.deps, hook('participant_left', `evt-${id}`, viewerId, 'PA_old'), 'mock-signature');
    expect((await w.store.getCapacity(id)).total).toBe(1);
  });
});
