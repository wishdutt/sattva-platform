import { describe, expect, it } from 'vitest';
import { chatMessageSchema, createEventSchema, inviteSchema, updateEventSchema } from './schemas';
import { formatDuration, initials, parseParticipantMetadata } from './format';

describe('createEventSchema', () => {
  const valid = {
    title: '  Launch day  ',
    startAt: '2026-11-01T17:00:00Z',
    durationMinutes: 60,
    timeZone: 'America/New_York',
  };

  it('applies defaults and trims', () => {
    const parsed = createEventSchema.parse(valid);
    expect(parsed.title).toBe('Launch day');
    expect(parsed.maxParticipants).toBe(50);
    expect(parsed.maxSpeakers).toBe(5);
    expect(parsed.recordingEnabled).toBe(false);
    expect(parsed.publish).toBe(true);
  });

  it('rejects participant limits above the platform ceiling', () => {
    expect(createEventSchema.safeParse({ ...valid, maxParticipants: 51 }).success).toBe(false);
    expect(createEventSchema.safeParse({ ...valid, maxSpeakers: 6 }).success).toBe(false);
  });

  it('rejects invalid time zones and timestamps', () => {
    expect(createEventSchema.safeParse({ ...valid, timeZone: 'Mars/Olympus' }).success).toBe(false);
    expect(createEventSchema.safeParse({ ...valid, startAt: 'tomorrow' }).success).toBe(false);
  });
});

describe('updateEventSchema', () => {
  it('rejects unknown fields and LIVE status transitions', () => {
    expect(updateEventSchema.safeParse({ organizerId: 'x' }).success).toBe(false);
    expect(updateEventSchema.safeParse({ status: 'LIVE' }).success).toBe(false);
    expect(updateEventSchema.safeParse({}).success).toBe(false);
  });
});

describe('inviteSchema', () => {
  it('normalizes and de-duplicates emails', () => {
    const parsed = inviteSchema.parse({ emails: ['A@Example.com', 'a@example.com ', 'b@example.com'] });
    expect(parsed.emails).toEqual(['a@example.com', 'b@example.com']);
    expect(parsed.role).toBe('VIEWER');
  });

  it('does not allow inviting organizers', () => {
    expect(inviteSchema.safeParse({ emails: ['a@example.com'], role: 'ORGANIZER' }).success).toBe(false);
  });
});

describe('chatMessageSchema', () => {
  it('strips control characters and enforces length', () => {
    expect(chatMessageSchema.parse({ text: ' hi\u0007 ' }).text).toBe('hi');
    expect(chatMessageSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(chatMessageSchema.safeParse({ text: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('format helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(65)).toBe('01:05');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
  it('builds initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('')).toBe('?');
  });
  it('parses participant metadata defensively', () => {
    expect(parseParticipantMetadata('{"role":"VIEWER","displayName":"A"}')?.role).toBe('VIEWER');
    expect(parseParticipantMetadata('{"role":"ADMIN"}')).toBeNull();
    expect(parseParticipantMetadata('not json')).toBeNull();
  });
});
