import { describe, expect, it } from 'vitest';
import type { MockLiveKit } from '../src/integrations/livekit';
import { TOKENS, createWorld } from './helpers';

describe('event lifecycle', () => {
  it('creates a scheduled event with the organizer as member', async () => {
    const w = createWorld();
    const res = await w.call('POST', '/events', TOKENS.organizer, {
      title: 'Launch',
      startAt: '2026-11-01T12:00:00-05:00',
      durationMinutes: 90,
      timeZone: 'America/Chicago',
      recordingEnabled: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'SCHEDULED',
      startAt: '2026-11-01T17:00:00.000Z', // normalized to UTC
      maxParticipants: 50,
      maxSpeakers: 5,
      myRole: 'ORGANIZER',
      canModerate: true,
    });
    expect(res.body.roomName).toBe(`evt-${res.body.id}`);
  });

  it('validates input with structured errors', async () => {
    const w = createWorld();
    const res = await w.call('POST', '/events', TOKENS.organizer, { title: '', durationMinutes: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['title', 'startAt', 'durationMinutes', 'timeZone']));
  });

  it('replays responses for a repeated Idempotency-Key', async () => {
    const w = createWorld();
    const body = { title: 'Once', startAt: '2026-11-01T17:00:00Z', durationMinutes: 30, timeZone: 'UTC' };
    const headers = { 'Idempotency-Key': 'create-once-123' };
    const a = await w.call('POST', '/events', TOKENS.organizer, body, headers);
    const b = await w.call('POST', '/events', TOKENS.organizer, body, headers);
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers['Idempotent-Replay']).toBe('true');
    expect(w.store.events.size).toBe(1);
  });

  it('moves READY -> LIVE -> ENDED and manages the LiveKit room', async () => {
    const w = createWorld();
    const lk = w.livekit as MockLiveKit;
    const id = await w.createEvent({ maxParticipants: 20 });

    const ready = await w.call('POST', `/events/${id}/start`, TOKENS.organizer, { goLive: false });
    expect(ready.body.status).toBe('READY');
    expect(lk.callsTo('ensureRoom')[0]!.args.slice(0, 2)).toEqual([`evt-${id}`, 22]);

    const live = await w.call('POST', `/events/${id}/start`, TOKENS.organizer, {});
    expect(live.body.status).toBe('LIVE');
    expect(live.body.liveStartedAt).toBeTruthy();
    // Idempotent
    expect((await w.call('POST', `/events/${id}/start`, TOKENS.organizer, {})).body.status).toBe('LIVE');

    const ended = await w.call('POST', `/events/${id}/end`, TOKENS.organizer, {});
    expect(ended.body.status).toBe('ENDED');
    expect(lk.callsTo('deleteRoom').map((c) => c.args[0])).toContain(`evt-${id}`);
    expect((await w.call('POST', `/events/${id}/start`, TOKENS.organizer, {})).status).toBe(409);
    expect((await w.call('PATCH', `/events/${id}`, TOKENS.organizer, { title: 'x' })).status).toBe(409);
  });

  it('enforces allowed status transitions on PATCH', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    expect((await w.call('PATCH', `/events/${id}`, TOKENS.organizer, { status: 'DRAFT' })).body.status).toBe('DRAFT');
    expect((await w.call('PATCH', `/events/${id}`, TOKENS.organizer, { status: 'CANCELLED' })).body.status).toBe(
      'CANCELLED',
    );
    expect((await w.call('PATCH', `/events/${id}`, TOKENS.organizer, { status: 'SCHEDULED' })).status).toBe(409);
  });

  it('does not allow schedule or capacity changes while live', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.goLive(id);
    const res = await w.call('PATCH', `/events/${id}`, TOKENS.organizer, { maxParticipants: 10 });
    expect(res.status).toBe(409);
    const ok = await w.call('PATCH', `/events/${id}`, TOKENS.organizer, { chatEnabled: false });
    expect(ok.body.chatEnabled).toBe(false);
  });

  it('broadcasters can start but not edit events', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.broadcaster, 'BROADCASTER');
    expect((await w.call('POST', `/events/${id}/start`, TOKENS.broadcaster, {})).body.status).toBe('LIVE');
    expect((await w.call('PATCH', `/events/${id}`, TOKENS.broadcaster, { title: 'x' })).status).toBe(403);
  });

  it('rejects thumbnail keys that belong to another event', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    const res = await w.call('PATCH', `/events/${id}`, TOKENS.organizer, { thumbnailKey: 'thumbnails/other/x.png' });
    expect(res.status).toBe(403);
    const upload = await w.call('POST', `/events/${id}/thumbnail-upload-url`, TOKENS.organizer, {
      contentType: 'image/png',
      contentLength: 1000,
    });
    expect(upload.body.key).toMatch(new RegExp(`^thumbnails/${id}/`));
    expect((await w.call('PATCH', `/events/${id}`, TOKENS.organizer, { thumbnailKey: upload.body.key })).status).toBe(200);
  });
});
