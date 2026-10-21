import {
  DATA_TOPICS,
  createEventSchema,
  roomNameForEvent,
  startEventSchema,
  thumbnailUploadSchema,
  updateEventSchema,
  type CapacityDto,
  type EventDto,
  type EventStatus,
} from '@lsp/shared';
import type { AuthUser } from '../auth/verifier';
import type { AppDeps } from '../deps';
import { ConditionFailedError, conflict, forbidden } from '../lib/errors';
import { newId } from '../lib/ids';
import type { EventRecord, MemberRecord } from '../store/types';
import { parse } from './validate';
import { audit, broadcast, loadAccess, requireHost, requireManage, toEventDto } from './access';
import { stopActiveRecording } from './recordings';

/** Extra LiveKit slots beyond the app limit: the Egress recorder joins as a hidden participant. */
const LIVEKIT_HEADROOM = 2;

export async function createEvent(deps: AppDeps, user: AuthUser, body: unknown): Promise<EventDto> {
  if (user.platformRole === 'USER') throw forbidden('Only organizers can create events');
  const input = parse(createEventSchema, body);
  const now = deps.now().toISOString();
  const id = newId();
  const event: EventRecord = {
    id,
    title: input.title,
    description: input.description,
    startAt: new Date(input.startAt).toISOString(),
    durationMinutes: input.durationMinutes,
    timeZone: input.timeZone,
    status: input.publish ? 'SCHEDULED' : 'DRAFT',
    organizerId: user.userId,
    roomName: roomNameForEvent(id),
    maxParticipants: input.maxParticipants,
    maxSpeakers: input.maxSpeakers,
    recordingEnabled: input.recordingEnabled,
    chatEnabled: input.chatEnabled,
    chatPersistence: input.chatPersistence,
    thumbnailKey: null,
    activeRecordingId: null,
    activeStreamSessionId: null,
    liveStartedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const organizer: MemberRecord = {
    eventId: id,
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    role: 'ORGANIZER',
    status: 'ACTIVE',
    canModerate: true,
    eventStartAt: event.startAt,
    joinedAt: now,
    updatedAt: now,
  };
  await deps.store.createEvent(event, organizer);
  await audit(deps, `EVENT#${id}`, 'event.created', user.userId, id, { title: event.title });
  await deps.bus.publish({ type: 'EventCreated', detail: { eventId: id, organizerId: user.userId } });
  return toEventDto(deps, event, { member: organizer, canModerate: true });
}

export async function listEvents(deps: AppDeps, user: AuthUser, scope: string | undefined) {
  if (scope === 'all') {
    if (user.platformRole !== 'ADMIN') throw forbidden('Admin only');
    const statuses: EventStatus[] = ['DRAFT', 'SCHEDULED', 'READY', 'LIVE', 'ENDED', 'CANCELLED'];
    const lists = await Promise.all(statuses.map((s) => deps.store.listEventsByStatus(s)));
    const events = lists.flat().sort((a, b) => b.startAt.localeCompare(a.startAt));
    return { items: await Promise.all(events.map((e) => toEventDto(deps, e, { isAdmin: true, canModerate: true }))) };
  }
  const memberships = (await deps.store.listMembershipsForUser(user.userId)).filter((m) => m.status === 'ACTIVE');
  const events = await deps.store.batchGetEvents(memberships.map((m) => m.eventId));
  const byId = new Map(memberships.map((m) => [m.eventId, m]));
  const items = await Promise.all(
    events
      // Viewers never see drafts.
      .filter((e) => e.status !== 'DRAFT' || byId.get(e.id)?.role === 'ORGANIZER')
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .map((e) => {
        const member = byId.get(e.id)!;
        const canModerate = member.role === 'ORGANIZER' || (member.role === 'BROADCASTER' && member.canModerate);
        return toEventDto(deps, e, { member, canModerate });
      }),
  );
  return { items };
}

export async function getEvent(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  if (access.event.status === 'DRAFT' && !access.canManage && !access.isHost) throw forbidden('Event not published');
  return toEventDto(deps, access.event, access);
}

export async function updateEvent(deps: AppDeps, user: AuthUser, eventId: string, body: unknown) {
  const access = await loadAccess(deps, user, eventId);
  requireManage(access);
  const input = parse(updateEventSchema, body);
  const current = access.event;

  const editable: EventStatus[] = ['DRAFT', 'SCHEDULED', 'READY', 'LIVE'];
  if (!editable.includes(current.status)) throw conflict('EVENT_CLOSED', `Cannot edit an event that is ${current.status}`);

  const scheduleFields = ['startAt', 'durationMinutes', 'timeZone', 'maxParticipants', 'maxSpeakers'] as const;
  if (current.status === 'LIVE' && scheduleFields.some((f) => input[f] !== undefined)) {
    throw conflict('EVENT_LIVE', 'Schedule and capacity cannot change while the event is live');
  }

  let ifStatusIn: EventStatus[] = editable;
  if (input.status) {
    const allowed: Record<string, EventStatus[]> = {
      DRAFT: ['SCHEDULED'],
      SCHEDULED: ['DRAFT'],
      CANCELLED: ['DRAFT', 'SCHEDULED', 'READY'],
    };
    ifStatusIn = allowed[input.status]!;
    if (!ifStatusIn.includes(current.status)) {
      throw conflict('INVALID_TRANSITION', `Cannot move event from ${current.status} to ${input.status}`);
    }
  }
  if (input.thumbnailKey && !input.thumbnailKey.startsWith(`thumbnails/${eventId}/`)) {
    throw forbidden('Thumbnail key does not belong to this event');
  }

  try {
    const updated = await deps.store.updateEvent(
      eventId,
      {
        ...input,
        startAt: input.startAt ? new Date(input.startAt).toISOString() : undefined,
        updatedAt: deps.now().toISOString(),
      },
      { ifStatusIn },
    );
    if (input.status === 'CANCELLED') await deps.livekit.deleteRoom(updated.roomName);
    if (input.chatEnabled !== undefined) {
      await broadcast(deps, updated, { type: 'settings', chatEnabled: updated.chatEnabled }, DATA_TOPICS.system);
    }
    await audit(deps, `EVENT#${eventId}`, 'event.updated', user.userId, eventId, { fields: Object.keys(input) });
    return toEventDto(deps, updated, access);
  } catch (err) {
    if (err instanceof ConditionFailedError) throw conflict('STALE_STATE', 'Event changed; reload and retry');
    throw err;
  }
}

export async function startEvent(deps: AppDeps, user: AuthUser, eventId: string, body: unknown) {
  const access = await loadAccess(deps, user, eventId);
  requireHost(access);
  const { goLive } = parse(startEventSchema, body ?? {});
  const event = access.event;

  if (event.status === 'LIVE') return toEventDto(deps, event, access); // idempotent
  if (event.status === 'READY' && !goLive) return toEventDto(deps, event, access);
  if (!['SCHEDULED', 'READY'].includes(event.status)) {
    throw conflict('INVALID_TRANSITION', `Cannot start an event that is ${event.status}`);
  }

  await deps.livekit.ensureRoom(
    event.roomName,
    event.maxParticipants + LIVEKIT_HEADROOM,
    JSON.stringify({ eventId: event.id, title: event.title }),
  );

  const now = deps.now().toISOString();
  try {
    if (!goLive) {
      const updated = await deps.store.updateEvent(eventId, { status: 'READY', updatedAt: now }, { ifStatusIn: ['SCHEDULED'] });
      await audit(deps, `EVENT#${eventId}`, 'event.ready', user.userId, eventId);
      return toEventDto(deps, updated, access);
    }
    const sessionId = newId();
    const updated = await deps.store.updateEvent(
      eventId,
      { status: 'LIVE', liveStartedAt: now, activeStreamSessionId: sessionId, updatedAt: now },
      { ifStatusIn: ['SCHEDULED', 'READY'] },
    );
    await deps.store.putStreamSession({
      id: sessionId,
      eventId,
      startedAt: now,
      startedBy: user.userId,
      endedAt: null,
      peakParticipants: 0,
    });
    await broadcast(deps, updated, { type: 'event_status', status: 'LIVE' }, DATA_TOPICS.system);
    await audit(deps, `EVENT#${eventId}`, 'event.live', user.userId, eventId);
    await deps.bus.publish({ type: 'EventStarted', detail: { eventId } });
    return toEventDto(deps, updated, access);
  } catch (err) {
    if (err instanceof ConditionFailedError) {
      // Lost a race with another host; return the current state.
      const latest = await deps.store.getEvent(eventId);
      return toEventDto(deps, latest!, access);
    }
    throw err;
  }
}

export async function endEvent(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireHost(access);
  const event = access.event;
  if (event.status === 'ENDED') return toEventDto(deps, event, access);
  if (!['READY', 'LIVE'].includes(event.status)) {
    throw conflict('INVALID_TRANSITION', `Cannot end an event that is ${event.status}`);
  }
  const now = deps.now().toISOString();
  await stopActiveRecording(deps, event, user.userId);
  await broadcast(deps, event, { type: 'event_status', status: 'ENDED' }, DATA_TOPICS.system);
  const updated = await deps.store.updateEvent(
    eventId,
    { status: 'ENDED', endedAt: now, updatedAt: now },
    { ifStatusIn: ['READY', 'LIVE'] },
  ).catch(async (err: unknown) => {
    if (err instanceof ConditionFailedError) return (await deps.store.getEvent(eventId))!;
    throw err;
  });
  // Deleting the room disconnects everyone, including holders of still-valid tokens.
  await deps.livekit.deleteRoom(event.roomName);

  const sessions = await deps.store.listParticipantSessions(eventId);
  await Promise.all(sessions.filter((s) => s.state !== 'LEFT').map((s) => deps.store.releaseParticipant(eventId, s.userId, now)));
  if (event.activeStreamSessionId) {
    await deps.store.endStreamSession(eventId, event.activeStreamSessionId, now, sessions.length);
  }
  await audit(deps, `EVENT#${eventId}`, 'event.ended', user.userId, eventId);
  await deps.bus.publish({ type: 'EventEnded', detail: { eventId } });
  return toEventDto(deps, updated, access);
}

export async function getCapacity(deps: AppDeps, user: AuthUser, eventId: string): Promise<CapacityDto> {
  const access = await loadAccess(deps, user, eventId);
  const c = await deps.store.getCapacity(eventId);
  return { total: c.total, max: access.event.maxParticipants, speakers: c.speakers, maxSpeakers: access.event.maxSpeakers };
}

export async function createThumbnailUpload(deps: AppDeps, user: AuthUser, eventId: string, body: unknown) {
  const access = await loadAccess(deps, user, eventId);
  requireManage(access);
  const input = parse(thumbnailUploadSchema, body);
  const ext = input.contentType.split('/')[1];
  const key = `thumbnails/${eventId}/${newId()}.${ext}`;
  const uploadUrl = await deps.storage.presignPut(key, input.contentType, input.contentLength, 300);
  return { uploadUrl, key };
}
