export const API_PREFIX = '/api/v1';

export const EVENT_STATUSES = ['DRAFT', 'SCHEDULED', 'READY', 'LIVE', 'ENDED', 'CANCELLED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Role a user holds inside one event. */
export const MEMBER_ROLES = ['ORGANIZER', 'BROADCASTER', 'VIEWER'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_STATUSES = ['ACTIVE', 'REMOVED'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** Platform-wide role, derived from Cognito groups. */
export const PLATFORM_ROLES = ['ADMIN', 'ORGANIZER', 'USER'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const COGNITO_GROUPS = {
  admin: 'platform-admins',
  organizer: 'organizers',
} as const;

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const SPEAKER_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVOKED'] as const;
export type SpeakerRequestStatus = (typeof SPEAKER_REQUEST_STATUSES)[number];

export const RECORDING_STATUSES = ['STARTING', 'ACTIVE', 'ENDING', 'READY', 'FAILED', 'DELETED'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const LIMITS = {
  /** Hard ceiling for connected participants in one event (all roles). */
  maxParticipants: 50,
  /** Hard ceiling for simultaneously approved audience speakers. */
  maxSpeakers: 5,
  chatMaxLength: 500,
  titleMaxLength: 120,
  descriptionMaxLength: 2000,
  invitesPerRequest: 50,
  invitationTtlHours: 72,
  /** LiveKit join tokens are short-lived; reconnects request a new one. */
  joinTokenTtlSeconds: 600,
  playbackUrlTtlSeconds: 900,
} as const;

export const RATE_LIMITS = {
  chat: { limit: 5, windowSeconds: 10 },
  reaction: { limit: 20, windowSeconds: 10 },
  raiseHand: { limit: 5, windowSeconds: 60 },
  joinToken: { limit: 20, windowSeconds: 60 },
  invite: { limit: 200, windowSeconds: 3600 },
} as const;

export const REACTIONS = ['👏', '❤️', '🔥', '😂', '🎉', '👍', '😮', '🙌'] as const;
export type Reaction = (typeof REACTIONS)[number];

/** LiveKit data-channel topics. All messages are published by the backend, never by clients. */
export const DATA_TOPICS = {
  chat: 'lsp.chat',
  reaction: 'lsp.reaction',
  moderation: 'lsp.moderation',
  speaker: 'lsp.speaker',
  system: 'lsp.system',
} as const;
export type DataTopic = (typeof DATA_TOPICS)[keyof typeof DATA_TOPICS];

export const roomNameForEvent = (eventId: string) => `evt-${eventId}`;
