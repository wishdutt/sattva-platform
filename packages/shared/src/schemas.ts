import { z } from 'zod';
import { EVENT_STATUSES, LIMITS, MEMBER_ROLES, REACTIONS } from './constants';

const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export const timeZoneSchema = z.string().min(1).max(64).refine(isValidTimeZone, 'Invalid IANA time zone');

/** ISO-8601 instant. Stored and transmitted in UTC. */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

const eventFields = {
  title: z.string().trim().min(1).max(LIMITS.titleMaxLength),
  description: z.string().trim().max(LIMITS.descriptionMaxLength).default(''),
  startAt: isoDateTimeSchema,
  durationMinutes: z.number().int().min(15).max(12 * 60),
  timeZone: timeZoneSchema,
  maxParticipants: z.number().int().min(2).max(LIMITS.maxParticipants).default(LIMITS.maxParticipants),
  maxSpeakers: z.number().int().min(0).max(LIMITS.maxSpeakers).default(LIMITS.maxSpeakers),
  recordingEnabled: z.boolean().default(false),
  chatEnabled: z.boolean().default(true),
  chatPersistence: z.boolean().default(true),
};

export const createEventSchema = z.object({
  ...eventFields,
  /** Create directly as SCHEDULED (default) or keep as DRAFT. */
  publish: z.boolean().default(true),
});
export type CreateEventInput = z.input<typeof createEventSchema>;

export const updateEventSchema = z
  .object({
    title: eventFields.title,
    description: z.string().trim().max(LIMITS.descriptionMaxLength),
    startAt: eventFields.startAt,
    durationMinutes: eventFields.durationMinutes,
    timeZone: eventFields.timeZone,
    maxParticipants: z.number().int().min(2).max(LIMITS.maxParticipants),
    maxSpeakers: z.number().int().min(0).max(LIMITS.maxSpeakers),
    recordingEnabled: z.boolean(),
    chatEnabled: z.boolean(),
    chatPersistence: z.boolean(),
    thumbnailKey: z.string().max(300).nullable(),
    /** Only DRAFT <-> SCHEDULED and -> CANCELLED transitions are allowed via PATCH. */
    status: z.enum(['DRAFT', 'SCHEDULED', 'CANCELLED']),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const startEventSchema = z
  .object({
    /** false = open the room backstage (READY) so hosts can prepare; true = go LIVE for viewers. */
    goLive: z.boolean().default(true),
  })
  .default({});

export const inviteSchema = z.object({
  emails: z
    .array(z.string().trim().toLowerCase().email().max(254))
    .min(1)
    .max(LIMITS.invitesPerRequest)
    .transform((list) => [...new Set(list)]),
  role: z.enum(['VIEWER', 'BROADCASTER']).default('VIEWER'),
  message: z.string().trim().max(500).optional(),
});
export type InviteInput = z.input<typeof inviteSchema>;

export const acceptInvitationSchema = z.object({
  token: z
    .string()
    .min(20)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/, 'Malformed invitation token'),
});

export const updateMemberSchema = z
  .object({
    role: z.enum(['VIEWER', 'BROADCASTER']),
    canModerate: z.boolean(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'At least one field is required');

export const chatMessageSchema = z.object({
  text: z
    .string()
    // Strip ASCII control characters (except tab/newline/carriage return).
    // eslint-disable-next-line no-control-regex
    .transform((s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim())
    .pipe(z.string().min(1).max(LIMITS.chatMaxLength)),
});

export const reactionSchema = z.object({
  emoji: z.enum(REACTIONS),
});

export const registerDeviceSchema = z.object({
  pushToken: z.string().min(10).max(300),
  platform: z.enum(['ios', 'android', 'web']),
});

export const thumbnailUploadSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
});

export const eventStatusSchema = z.enum(EVENT_STATUSES);
export const memberRoleSchema = z.enum(MEMBER_ROLES);
