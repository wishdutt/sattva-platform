import { describe, expect, it } from 'vitest';
import { createDevVerifier, platformRoleFromGroups } from '../src/auth/verifier';
import { TOKENS, createWorld } from './helpers';

describe('authentication', () => {
  it('rejects requests without a bearer token', async () => {
    const w = await createWorld();
    const res = await w.call('GET', '/events', null);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed tokens', async () => {
    const w = await createWorld();
    const res = await w.call('GET', '/events', 'not-a-token');
    expect(res.status).toBe(401);
  });

  it('maps Cognito groups to platform roles', () => {
    expect(platformRoleFromGroups(['platform-admins', 'organizers'])).toBe('ADMIN');
    expect(platformRoleFromGroups(['organizers'])).toBe('ORGANIZER');
    expect(platformRoleFromGroups([])).toBe('USER');
  });

  it('refuses to build the dev verifier inside Lambda', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'lsp-api';
    try {
      expect(() => createDevVerifier()).toThrow(/never run in AWS Lambda/);
    } finally {
      delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    }
  });

  it('dev verifier derives distinct ids for emails sharing a long prefix', async () => {
    const v = createDevVerifier();
    const a = await v.verify('dev:loadtest-1@example.com');
    const b = await v.verify('dev:loadtest-2@example.com');
    expect(a.userId).not.toBe(b.userId);
  });

  it('returns the caller profile from verified claims', async () => {
    const w = await createWorld();
    const res = await w.call('GET', '/me', TOKENS.organizer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'org@example.com', platformRole: 'ORGANIZER', canCreateEvents: true });
  });
});

describe('authorization', () => {
  it('only organizers and admins can create events', async () => {
    const w = await createWorld();
    const res = await w.call('POST', '/events', TOKENS.viewer, {
      title: 'x',
      startAt: '2026-11-01T17:00:00Z',
      durationMinutes: 30,
      timeZone: 'UTC',
    });
    expect(res.status).toBe(403);
  });

  it('hides events from non-members with 404', async () => {
    const w = await createWorld();
    const id = await w.createEvent();
    expect((await w.call('GET', `/events/${id}`, TOKENS.stranger)).status).toBe(404);
    expect((await w.call('GET', `/events/${id}`, TOKENS.otherOrganizer)).status).toBe(404);
    expect((await w.call('POST', `/events/${id}/join-token`, TOKENS.stranger, {})).status).toBe(404);
  });

  it('lists only events the user belongs to', async () => {
    const w = await createWorld();
    const a = await w.createEvent({ title: 'A' });
    await w.createEvent({ title: 'B' });
    await w.addMember(a, TOKENS.viewer);
    const res = await w.call('GET', '/events', TOKENS.viewer);
    expect(res.body.items.map((e: { title: string }) => e.title)).toEqual(['A']);
    expect(res.body.items[0].myRole).toBe('VIEWER');
  });

  it('viewers cannot see draft events', async () => {
    const w = await createWorld();
    const id = await w.createEvent({ publish: false });
    await w.addMember(id, TOKENS.viewer);
    expect((await w.call('GET', '/events', TOKENS.viewer)).body.items).toHaveLength(0);
    expect((await w.call('GET', `/events/${id}`, TOKENS.viewer)).status).toBe(403);
  });

  it('admin can list all events; others cannot use scope=all', async () => {
    const w = await createWorld();
    await w.createEvent();
    expect((await w.call('GET', '/events?scope=all', TOKENS.admin)).body.items).toHaveLength(1);
    expect((await w.call('GET', '/events?scope=all', TOKENS.organizer)).status).toBe(403);
  });

  it('viewers cannot manage events', async () => {
    const w = await createWorld();
    const id = await w.createEvent();
    await w.addMember(id, TOKENS.viewer);
    expect((await w.call('PATCH', `/events/${id}`, TOKENS.viewer, { title: 'hacked' })).status).toBe(403);
    expect((await w.call('POST', `/events/${id}/start`, TOKENS.viewer, {})).status).toBe(403);
    expect((await w.call('POST', `/events/${id}/invitations`, TOKENS.viewer, { emails: ['x@y.com'] })).status).toBe(403);
    expect((await w.call('GET', `/events/${id}/members`, TOKENS.viewer)).status).toBe(403);
  });
});
