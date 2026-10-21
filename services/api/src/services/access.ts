import { RATE_LIMITS, type EventDto, type MemberRole, type ParticipantMetadata } from '@lsp/shared';
import type { AuthUser } from '../auth/verifier';
import type { AppDeps } from '../deps';
import type { ParticipantGrant } from '../integrations/livekit';
import { forbidden, notFound, tooManyRequests } from '../lib/errors';
import { newId } from '../lib/ids';
import type { EventRecord, MemberRecord } from '../store/types';

export interface EventAccess {
  event: EventRecord;
  member: MemberRecord | null;
  isAdmin: boolean;
  /** Organizer of this event (or platform admin). */
  canManage: boolean;
  /** Organizer, admin, or broadcaster with moderation rights. */
  canModerate: boolean;
  /** Organizer or broadcaster — may publish media. */
  isHost: boolean;
}

export const isHostRole = (role: MemberRole) => role === 'ORGANIZER' || role === 'BROADCASTER';

/**
 * Loads an event and the caller's relationship to it. Non-members get 404 (not 403)
 * so that event IDs cannot be probed.
 */
export async function loadAccess(deps: AppDeps, user: AuthUser, eventId: string): Promise<EventAccess> {
  const [event, member] = await Promise.all([
    deps.store.getEvent(eventId),
    deps.store.getMember(eventId, user.userId),
  ]);
  const activeMember = member?.status === 'ACTIVE' ? member : null;
  const isAdmin = user.platformRole === 'ADMIN';
  if (!event || (!activeMember && !isAdmin)) throw notFound('Event');
  const isOrganizer = activeMember?.role === 'ORGANIZER';
  return {
    event,
    member: activeMember,
    isAdmin,
    canManage: isOrganizer || isAdmin,
    canModerate: isOrganizer || isAdmin || (activeMember?.role === 'BROADCASTER' && activeMember.canModerate),
    isHost: !!activeMember && isHostRole(activeMember.role),
  };
}

export function requireManage(access: EventAccess) {
  if (!access.canManage) throw forbidden('Only the event organizer can do this');
}

export function requireModerate(access: EventAccess) {
  if (!access.canModerate) throw forbidden('Moderator permission required');
}

export function requireHost(access: EventAccess) {
  if (!access.isHost && !access.isAdmin) throw forbidden('Only hosts can do this');
}

export async function enforceRateLimit(deps: AppDeps, name: keyof typeof RATE_LIMITS, subject: string) {
  const { limit, windowSeconds } = RATE_LIMITS[name];
  const ok = await deps.store.hitRateLimit(`${name}#${subject}`, limit, windowSeconds, deps.now().getTime());
  if (!ok) throw tooManyRequests();
}

export async function audit(
  deps: AppDeps,
  scope: string,
  action: string,
  actorId: string | null,
  targetId: string | null,
  details: Record<string, unknown> = {},
) {
  const at = deps.now().toISOString();
  try {
    await deps.store.putAudit({
      id: newId(),
      scope,
      action,
      actorId,
      targetId,
      details,
      at,
      ttl: Math.floor(deps.now().getTime() / 1000) + deps.config.auditRetentionDays * 86_400,
    });
  } catch (err) {
    deps.logger.error('audit write failed', { action, err });
  }
  deps.logger.info('audit', { scope, action, actorId, targetId });
}

export function grantFor(role: MemberRole, isSpeaker: boolean): ParticipantGrant {
  if (isHostRole(role)) {
    return {
      canPublish: true,
      canPublishSources: ['camera', 'microphone', 'screen_share', 'screen_share_audio'],
      canSubscribe: true,
      canPublishData: false,
    };
  }
  if (isSpeaker) {
    return { canPublish: true, canPublishSources: ['camera', 'microphone'], canSubscribe: true, canPublishData: false };
  }
  return { canPublish: false, canPublishSources: [], canSubscribe: true, canPublishData: false };
}

export function participantMetadata(role: MemberRole, displayName: string, speaker: boolean): string {
  const meta: ParticipantMetadata = { role, displayName, speaker };
  return JSON.stringify(meta);
}

export async function toEventDto(deps: AppDeps, event: EventRecord, access?: Partial<EventAccess>): Promise<EventDto> {
  const thumbnailUrl = event.thumbnailKey ? await deps.storage.presignGet(event.thumbnailKey, 3600) : null;
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    startAt: event.startAt,
    durationMinutes: event.durationMinutes,
    timeZone: event.timeZone,
    status: event.status,
    organizerId: event.organizerId,
    roomName: event.roomName,
    maxParticipants: event.maxParticipants,
    maxSpeakers: event.maxSpeakers,
    recordingEnabled: event.recordingEnabled,
    chatEnabled: event.chatEnabled,
    chatPersistence: event.chatPersistence,
    thumbnailUrl,
    recordingActive: !!event.activeRecordingId,
    liveStartedAt: event.liveStartedAt,
    endedAt: event.endedAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    myRole: access?.member?.role ?? null,
    canModerate: !!access?.canModerate,
  };
}

/** Best-effort real-time notification; persistence is the source of truth. */
export async function broadcast(
  deps: AppDeps,
  event: EventRecord,
  payload: unknown,
  topic: string,
  destinationIdentities?: string[],
) {
  if (event.status !== 'LIVE' && event.status !== 'READY') return;
  try {
    await deps.livekit.sendData(event.roomName, payload, topic, destinationIdentities);
  } catch (err) {
    deps.logger.warn('livekit sendData failed', { eventId: event.id, topic, err });
  }
}
