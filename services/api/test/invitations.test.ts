import { describe, expect, it } from 'vitest';
import type { MockLiveKit } from '../src/integrations/livekit';
import { sha256 } from '../src/lib/ids';
import { TOKENS, createWorld } from './helpers';

const tokenFromMail = (text: string) => text.match(/token=([\w-]+)/)![1]!;

describe('invitations', () => {
  it('emails a single-use link and stores only the token hash', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    const res = await w.call('POST', `/events/${id}/invitations`, TOKENS.organizer, {
      emails: ['Viewer@Example.com'],
    });
    expect(res.status).toBe(201);
    expect(res.body.items[0]).toMatchObject({ email: 'viewer@example.com', status: 'PENDING', role: 'VIEWER' });
    const mail = w.mailer.outbox[0]!;
    expect(mail.to).toBe('viewer@example.com');
    expect(mail.text).toContain('https://app.test/invite?token=');
    const token = tokenFromMail(mail.text);
    const stored = [...w.store.invitations.values()][0]!;
    expect(stored.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('skips addresses that already have a pending invite or membership', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.viewer);
    await w.call('POST', `/events/${id}/invitations`, TOKENS.organizer, { emails: ['viewer2@example.com'] });
    const res = await w.call('POST', `/events/${id}/invitations`, TOKENS.organizer, {
      emails: ['viewer@example.com', 'viewer2@example.com', 'viewer3@example.com'],
    });
    expect(res.body.items.map((i: { email: string }) => i.email)).toEqual(['viewer3@example.com']);
    expect(res.body.skipped).toEqual(['viewer@example.com', 'viewer2@example.com']);
  });

  it('requires authentication and the invited, verified email address', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.call('POST', `/events/${id}/invitations`, TOKENS.organizer, { emails: ['viewer@example.com'] });
    const token = tokenFromMail(w.mailer.outbox[0]!.text);

    expect((await w.call('POST', '/invitations/accept', null, { token })).status).toBe(401);
    const wrong = await w.call('POST', '/invitations/accept', TOKENS.stranger, { token });
    expect(wrong.status).toBe(403);
    expect((await w.call('GET', `/events/${id}`, TOKENS.stranger)).status).toBe(404);

    const ok = await w.call('POST', '/invitations/accept', TOKENS.viewer, { token });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ eventId: id, role: 'VIEWER' });
    expect((await w.call('GET', `/events/${id}`, TOKENS.viewer)).status).toBe(200);
  });

  it('is single-use but idempotent for the same user', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    const token = await w.addMember(id, TOKENS.viewer);
    expect((await w.call('POST', '/invitations/accept', TOKENS.viewer, { token })).status).toBe(200);
    // Another account with the same token is refused (token was consumed).
    const other = await w.call('POST', '/invitations/accept', TOKENS.viewer2, { token });
    expect(other.status).toBe(410);
    expect(other.body.error.code).toBe('INVITATION_USED');
  });

  it('rejects expired invitations', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.call('POST', `/events/${id}/invitations`, TOKENS.organizer, { emails: ['viewer@example.com'] });
    const token = tokenFromMail(w.mailer.outbox[0]!.text);
    w.advance(73 * 3_600_000);
    const res = await w.call('POST', '/invitations/accept', TOKENS.viewer, { token });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('INVITATION_EXPIRED');
    const list = await w.call('GET', `/events/${id}/invitations`, TOKENS.organizer);
    expect(list.body.items[0].status).toBe('EXPIRED');
  });

  it('rejects revoked invitations', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    const inv = await w.call('POST', `/events/${id}/invitations`, TOKENS.organizer, { emails: ['viewer@example.com'] });
    const token = tokenFromMail(w.mailer.outbox[0]!.text);
    expect((await w.call('DELETE', `/events/${id}/invitations/${inv.body.items[0].id}`, TOKENS.organizer)).status).toBe(204);
    const res = await w.call('POST', '/invitations/accept', TOKENS.viewer, { token });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('INVITATION_REVOKED');
  });

  it('rejects malformed and unknown tokens', async () => {
    const w = createWorld();
    expect((await w.call('POST', '/invitations/accept', TOKENS.viewer, { token: 'short' })).status).toBe(400);
    expect((await w.call('POST', '/invitations/accept', TOKENS.viewer, { token: 'x'.repeat(43) })).status).toBe(404);
  });

  it('previews an invitation for the invited user', async () => {
    const w = createWorld();
    const id = await w.createEvent({ title: 'Board meeting' });
    await w.call('POST', `/events/${id}/invitations`, TOKENS.organizer, { emails: ['viewer@example.com'] });
    const token = tokenFromMail(w.mailer.outbox[0]!.text);
    const res = await w.call('POST', '/invitations/preview', TOKENS.viewer, { token });
    expect(res.body).toEqual({ eventId: id, eventTitle: 'Board meeting', role: 'VIEWER' });
  });
});

describe('membership management', () => {
  it('removing a member kicks them from the room and blocks new tokens', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.viewer);
    await w.goLive(id);
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {})).status).toBe(200);
    const viewerId = await w.userId(TOKENS.viewer);

    expect((await w.call('DELETE', `/events/${id}/members/${viewerId}`, TOKENS.organizer)).status).toBe(204);
    const lk = w.livekit as MockLiveKit;
    expect(lk.callsTo('removeParticipant').map((c) => c.args[1])).toContain(viewerId);
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.viewer, {})).status).toBe(404);
    expect((await w.store.getCapacity(id)).total).toBe(0);
  });

  it('organizer can assign the broadcaster role, which updates live permissions', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.viewer);
    await w.goLive(id);
    const viewerId = await w.userId(TOKENS.viewer);
    const res = await w.call('PATCH', `/events/${id}/members/${viewerId}`, TOKENS.organizer, { role: 'BROADCASTER' });
    expect(res.body).toMatchObject({ role: 'BROADCASTER', canModerate: true });
    const update = (w.livekit as MockLiveKit).callsTo('updateParticipant').at(-1)!;
    expect(update.args[2]).toMatchObject({ canPublish: true });
  });

  it('the organizer cannot be removed', async () => {
    const w = createWorld();
    const id = await w.createEvent();
    const orgId = await w.userId(TOKENS.organizer);
    expect((await w.call('DELETE', `/events/${id}/members/${orgId}`, TOKENS.organizer)).status).toBe(409);
  });
});
