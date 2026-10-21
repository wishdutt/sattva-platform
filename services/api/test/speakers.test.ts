import { describe, expect, it } from 'vitest';
import { DATA_TOPICS } from '@lsp/shared';
import type { MockLiveKit } from '../src/integrations/livekit';
import { TOKENS, createWorld } from './helpers';

async function liveWithViewers(maxSpeakers = 5) {
  const w = await createWorld();
  const id = await w.createEvent({ maxSpeakers });
  await w.addMember(id, TOKENS.broadcaster, 'BROADCASTER');
  for (const t of [TOKENS.viewer, TOKENS.viewer2, TOKENS.viewer3]) await w.addMember(id, t);
  await w.goLive(id);
  for (const t of [TOKENS.organizer, TOKENS.broadcaster, TOKENS.viewer, TOKENS.viewer2, TOKENS.viewer3]) {
    await w.call('POST', `/events/${id}/join-token`, t, {});
  }
  return { w, id, lk: w.livekit as MockLiveKit };
}

describe('raise hand', () => {
  it('records one open request per user and notifies moderators', async () => {
    const { w, id, lk } = await liveWithViewers();
    const a = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    const b = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    expect(a.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    const notifications = lk.callsTo('sendData').filter((c) => c.args[2] === DATA_TOPICS.moderation);
    expect(notifications).toHaveLength(1);
    const destinations = notifications[0]!.args[3] as string[];
    expect(destinations).toEqual(
      expect.arrayContaining([await w.userId(TOKENS.organizer), await w.userId(TOKENS.broadcaster)]),
    );
    expect(destinations).not.toContain(await w.userId(TOKENS.viewer2));
  });

  it('requires being in the room and the event being live', async () => {
    const w = await createWorld();
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.viewer);
    expect((await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {})).status).toBe(409);
    await w.goLive(id);
    const res = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    expect(res.body.error.code).toBe('NOT_IN_ROOM');
  });

  it('can be lowered and raised again', async () => {
    const { w, id } = await liveWithViewers();
    const first = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    expect((await w.call('DELETE', `/events/${id}/raise-hand`, TOKENS.viewer)).status).toBe(204);
    const second = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    expect(second.body.id).not.toBe(first.body.id);
    expect((await w.store.getSpeakerRequest(id, first.body.id))?.status).toBe('CANCELLED');
  });
});

describe('speaker approval', () => {
  it('approval grants publish permission through LiveKit and future tokens', async () => {
    const { w, id, lk } = await liveWithViewers();
    const req = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    const res = await w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.broadcaster, {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('APPROVED');

    const viewerId = await w.userId(TOKENS.viewer);
    const update = lk.callsTo('updateParticipant').at(-1)!;
    expect(update.args[1]).toBe(viewerId);
    expect(update.args[2]).toEqual({
      canPublish: true,
      canPublishSources: ['camera', 'microphone'],
      canSubscribe: true,
      canPublishData: false,
    });
    expect(JSON.parse(update.args[3] as string)).toMatchObject({ speaker: true });
    const notify = lk.callsTo('sendData').find((c) => c.args[2] === DATA_TOPICS.speaker);
    expect(notify?.args[3]).toEqual([viewerId]);

    // A reconnect gets a token that already includes speaker rights.
    const token = await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {});
    expect(token.body.canPublish).toBe(true);
    const mockClaims = JSON.parse(Buffer.from(token.body.token.slice(5), 'base64url').toString());
    expect(mockClaims.grant.canPublishSources).toEqual(['camera', 'microphone']);
  });

  it('only moderators can approve', async () => {
    const { w, id } = await liveWithViewers();
    const req = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    const res = await w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.viewer2, {});
    expect(res.status).toBe(403);
    // Self-approval is also impossible.
    expect((await w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.viewer, {})).status).toBe(403);
  });

  it('broadcasters without moderation rights cannot approve', async () => {
    const { w, id } = await liveWithViewers();
    const hostId = await w.userId(TOKENS.broadcaster);
    await w.call('PATCH', `/events/${id}/members/${hostId}`, TOKENS.organizer, { canModerate: false });
    const req = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    expect((await w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.broadcaster, {})).status).toBe(403);
  });

  it('enforces the speaker limit under concurrent approvals', async () => {
    const { w, id } = await liveWithViewers(1);
    const r1 = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    const r2 = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer2, {});
    const results = await Promise.all([
      w.call('POST', `/events/${id}/speaker-requests/${r1.body.id}/approve`, TOKENS.organizer, {}),
      w.call('POST', `/events/${id}/speaker-requests/${r2.body.id}/approve`, TOKENS.broadcaster, {}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('SPEAKER_LIMIT');
    expect((await w.store.getCapacity(id)).speakers).toBe(1);
  });

  it('two moderators approving the same request consume one slot', async () => {
    const { w, id } = await liveWithViewers(5);
    const req = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    const results = await Promise.all([
      w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.organizer, {}),
      w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.broadcaster, {}),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await w.store.getCapacity(id)).speakers).toBe(1);
  });

  it('cancels requests from users who already disconnected', async () => {
    const { w, id } = await liveWithViewers();
    const req = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    await w.call('POST', `/events/${id}/leave`, TOKENS.viewer, {});
    // Leaving already cancelled the pending request.
    const res = await w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.organizer, {});
    expect(res.status).toBe(409);
    expect((await w.store.getCapacity(id)).speakers).toBe(0);
  });

  it('rejecting notifies the requester and frees them to ask again', async () => {
    const { w, id } = await liveWithViewers();
    const req = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    const res = await w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/reject`, TOKENS.organizer, {});
    expect(res.body.status).toBe('REJECTED');
    expect((await w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.organizer, {})).status).toBe(409);
    const again = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    expect(again.body.status).toBe('PENDING');
  });
});

describe('demotion', () => {
  it('revokes publish permissions and frees the slot', async () => {
    const { w, id, lk } = await liveWithViewers(1);
    const viewerId = await w.userId(TOKENS.viewer);
    const req = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    await w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.organizer, {});

    expect((await w.call('POST', `/events/${id}/speakers/${viewerId}/demote`, TOKENS.broadcaster, {})).status).toBe(204);
    const update = lk.callsTo('updateParticipant').at(-1)!;
    expect(update.args[2]).toMatchObject({ canPublish: false, canPublishSources: [] });
    expect((await w.store.getCapacity(id)).speakers).toBe(0);
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {})).body.canPublish).toBe(false);

    // Slot is reusable.
    const r2 = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer2, {});
    expect((await w.call('POST', `/events/${id}/speaker-requests/${r2.body.id}/approve`, TOKENS.organizer, {})).status).toBe(200);
  });

  it('demoting a non-speaker returns 404; viewers cannot demote', async () => {
    const { w, id } = await liveWithViewers();
    const viewerId = await w.userId(TOKENS.viewer);
    expect((await w.call('POST', `/events/${id}/speakers/${viewerId}/demote`, TOKENS.organizer, {})).status).toBe(404);
    expect((await w.call('POST', `/events/${id}/speakers/${viewerId}/demote`, TOKENS.viewer2, {})).status).toBe(403);
  });

  it('a speaker who disconnects loses the slot', async () => {
    const { w, id } = await liveWithViewers(1);
    const req = await w.call('POST', `/events/${id}/raise-hand`, TOKENS.viewer, {});
    await w.call('POST', `/events/${id}/speaker-requests/${req.body.id}/approve`, TOKENS.organizer, {});
    await w.call('POST', `/events/${id}/leave`, TOKENS.viewer, {});
    expect((await w.store.getCapacity(id)).speakers).toBe(0);
  });
});
