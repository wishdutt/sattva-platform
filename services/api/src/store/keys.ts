/**
 * Single-table key design. See docs/database.md for the full access-pattern table.
 *
 * Base table:   PK / SK
 * GSI1:         GSI1PK / GSI1SK  (organizer's events, user's memberships, email -> user)
 * GSI2:         GSI2PK / GSI2SK  (events by status, invitation token lookup, egress lookup)
 * TTL attribute: ttl (epoch seconds)
 */
export const keys = {
  user: (userId: string) => ({ PK: `USER#${userId}`, SK: 'PROFILE' }),
  userEmailIndex: (email: string) => ({ GSI1PK: `EMAIL#${email}`, GSI1SK: 'USER' }),
  device: (userId: string, tokenHash: string) => ({ PK: `USER#${userId}`, SK: `DEVICE#${tokenHash}` }),

  event: (eventId: string) => ({ PK: `EVENT#${eventId}`, SK: 'META' }),
  eventByOrganizer: (organizerId: string, startAt: string, eventId: string) => ({
    GSI1PK: `ORG#${organizerId}`,
    GSI1SK: `${startAt}#${eventId}`,
  }),
  eventByStatus: (status: string, startAt: string, eventId: string) => ({
    GSI2PK: `STATUS#${status}`,
    GSI2SK: `${startAt}#${eventId}`,
  }),

  member: (eventId: string, userId: string) => ({ PK: `EVENT#${eventId}`, SK: `MEMBER#${userId}` }),
  memberByUser: (userId: string, startAt: string, eventId: string) => ({
    GSI1PK: `MEMBER#${userId}`,
    GSI1SK: `${startAt}#${eventId}`,
  }),

  invitation: (eventId: string, invitationId: string) => ({ PK: `EVENT#${eventId}`, SK: `INVITE#${invitationId}` }),
  invitationByToken: (tokenHash: string) => ({ GSI2PK: `INVTOKEN#${tokenHash}`, GSI2SK: 'INVITE' }),

  capacity: (eventId: string) => ({ PK: `EVENT#${eventId}`, SK: 'CAPACITY' }),
  participant: (eventId: string, userId: string) => ({ PK: `EVENT#${eventId}`, SK: `PSESSION#${userId}` }),

  speakerRequest: (eventId: string, requestId: string) => ({ PK: `EVENT#${eventId}`, SK: `SPKREQ#${requestId}` }),
  /** Lock item guaranteeing at most one open (PENDING/APPROVED) request per user per event. */
  handLock: (eventId: string, userId: string) => ({ PK: `EVENT#${eventId}`, SK: `HAND#${userId}` }),

  stream: (eventId: string, sessionId: string) => ({ PK: `EVENT#${eventId}`, SK: `STREAM#${sessionId}` }),
  chat: (eventId: string, messageId: string) => ({ PK: `EVENT#${eventId}#CHAT`, SK: `MSG#${messageId}` }),

  recording: (eventId: string, recordingId: string) => ({ PK: `EVENT#${eventId}`, SK: `REC#${recordingId}` }),
  recordingByEgress: (egressId: string) => ({ GSI2PK: `EGRESS#${egressId}`, GSI2SK: 'REC' }),

  audit: (scope: string, at: string, id: string) => ({ PK: `AUDIT#${scope}`, SK: `${at}#${id}` }),
  rate: (key: string, window: number) => ({ PK: `RATE#${key}#${window}`, SK: 'RATE' }),
  idempotency: (key: string) => ({ PK: `IDEM#${key}`, SK: 'IDEM' }),
} as const;

export const KEY_ATTRS = ['PK', 'SK', 'GSI1PK', 'GSI1SK', 'GSI2PK', 'GSI2SK', 'entity'] as const;

export function stripKeys<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const out: Record<string, unknown> = { ...item };
  for (const k of KEY_ATTRS) delete out[k];
  return out as T;
}
