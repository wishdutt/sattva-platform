import { describe, expect, it } from 'vitest';
import { DATA_TOPICS } from '@lsp/shared';
import type { MockLiveKit } from '../src/integrations/livekit';
import { reconcileEvent } from '../src/services/jobs';
import { TOKENS, createWorld } from './helpers';

async function liveEvent(overrides: Record<string, unknown> = {}) {
  const w = createWorld();
  const id = await w.createEvent(overrides);
  await w.addMember(id, TOKENS.viewer);
  await w.addMember(id, TOKENS.viewer2);
  await w.goLive(id);
  return { w, id, lk: w.livekit as MockLiveKit };
}

describe('API validation', () => {
  it('returns 404 for unknown routes and 405 for wrong methods', async () => {
    const w = createWorld();
    expect((await w.call('GET', '/nope', TOKENS.viewer)).status).toBe(404);
    expect((await w.call('PUT', '/events', TOKENS.viewer, {})).status).toBe(405);
  });

  it('rejects invalid JSON and oversized bodies', async () => {
    const w = createWorld();
    expect((await w.call('POST', '/events', TOKENS.organizer, '{bad')).status).toBe(400);
    expect((await w.call('POST', '/events', TOKENS.organizer, 'x'.repeat(70_000))).status).toBe(413);
  });

  it('includes a request id and security headers', async () => {
    const w = createWorld();
    const res = await w.call('GET', '/me', TOKENS.viewer);
    expect(res.headers['X-Request-Id']).toBeTruthy();
    expect(res.headers['Cache-Control']).toBe('no-store');
  });
});

describe('chat', () => {
  it('stamps sender identity from the server, persists, and relays over LiveKit', async () => {
    const { w, id, lk } = await liveEvent();
    const res = await w.call('POST', `/events/${id}/chat`, TOKENS.viewer, {
      text: 'Hello!',
      userId: 'spoofed',
      displayName: 'CEO',
      role: 'ORGANIZER',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userId: await w.userId(TOKENS.viewer), displayName: 'viewer', role: 'VIEWER' });
    const relay = lk.callsTo('sendData').find((c) => c.args[2] === DATA_TOPICS.chat)!;
    expect((relay.args[1] as { message: { text: string } }).message.text).toBe('Hello!');
    expect((await w.call('GET', `/events/${id}/chat`, TOKENS.viewer2)).body.items).toHaveLength(1);
  });

  it('does not persist when persistence is disabled', async () => {
    const { w, id } = await liveEvent({ chatPersistence: false });
    await w.call('POST', `/events/${id}/chat`, TOKENS.viewer, { text: 'ephemeral' });
    expect(w.store.chat.size).toBe(0);
  });

  it('rate limits chat per user', async () => {
    const { w, id } = await liveEvent();
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await w.call('POST', `/events/${id}/chat`, TOKENS.viewer, { text: `m${i}` })).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    // Other users are unaffected.
    expect((await w.call('POST', `/events/${id}/chat`, TOKENS.viewer2, { text: 'hi' })).status).toBe(201);
  });

  it('honors chat disablement for viewers but not moderators', async () => {
    const { w, id } = await liveEvent();
    await w.call('PATCH', `/events/${id}`, TOKENS.organizer, { chatEnabled: false });
    expect((await w.call('POST', `/events/${id}/chat`, TOKENS.viewer, { text: 'hi' })).body.error.code).toBe('CHAT_DISABLED');
    expect((await w.call('POST', `/events/${id}/chat`, TOKENS.organizer, { text: 'announcement' })).status).toBe(201);
  });

  it('moderators can delete messages; viewers cannot', async () => {
    const { w, id } = await liveEvent();
    const msg = await w.call('POST', `/events/${id}/chat`, TOKENS.viewer, { text: 'oops' });
    expect((await w.call('DELETE', `/events/${id}/chat/${msg.body.id}`, TOKENS.viewer2)).status).toBe(403);
    expect((await w.call('DELETE', `/events/${id}/chat/${msg.body.id}`, TOKENS.organizer)).status).toBe(204);
    const list = await w.call('GET', `/events/${id}/chat`, TOKENS.viewer);
    expect(list.body.items[0]).toMatchObject({ deleted: true, text: '' });
  });

  it('accepts only whitelisted reactions', async () => {
    const { w, id } = await liveEvent();
    expect((await w.call('POST', `/events/${id}/reactions`, TOKENS.viewer, { emoji: '👏' })).status).toBe(204);
    expect((await w.call('POST', `/events/${id}/reactions`, TOKENS.viewer, { emoji: '<script>' })).status).toBe(400);
  });
});

describe('reconciliation', () => {
  it('frees stale admissions and kicks non-members found in the room', async () => {
    const { w, id, lk } = await liveEvent();
    await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {});
    const viewer2 = await w.userId(TOKENS.viewer2);
    await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer2, {});
    lk.participants.set(`evt-${id}`, [
      { identity: viewer2, sid: 'PA_2', joinedAt: 0 },
      { identity: 'ghost', sid: 'PA_x', joinedAt: 0 },
    ]);
    w.advance(5 * 60_000);
    const event = (await w.store.getEvent(id))!;
    const result = await reconcileEvent(w.deps, event);
    expect(result.released).toBe(1); // viewer never connected
    expect(result.removed).toBe(1); // ghost
    expect(result.capacity.total).toBe(1);
  });
});
