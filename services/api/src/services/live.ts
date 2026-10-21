import { DATA_TOPICS, type JoinTokenDto, type SpeakerRequestDto } from '@lsp/shared';
import type { AuthUser } from '../auth/verifier';
import type { AppDeps } from '../deps';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import type { EventRecord, SpeakerRequestRecord } from '../store/types';
import {
  audit,
  broadcast,
  enforceRateLimit,
  grantFor,
  isHostRole,
  loadAccess,
  participantMetadata,
  requireModerate,
} from './access';

export const toSpeakerRequestDto = (r: SpeakerRequestRecord): SpeakerRequestDto => ({
  id: r.id,
  eventId: r.eventId,
  userId: r.userId,
  displayName: r.displayName,
  status: r.status,
  createdAt: r.createdAt,
  resolvedAt: r.resolvedAt,
  resolvedBy: r.resolvedBy,
});

async function moderatorIdentities(deps: AppDeps, eventId: string) {
  const members = await deps.store.listMembers(eventId);
  return members
    .filter((m) => m.status === 'ACTIVE' && (m.role === 'ORGANIZER' || (m.role === 'BROADCASTER' && m.canModerate)))
    .map((m) => m.userId);
}

function requireLive(event: EventRecord) {
  if (event.status !== 'LIVE') throw conflict('EVENT_NOT_LIVE', 'The event is not live');
}

export async function issueJoinToken(deps: AppDeps, user: AuthUser, eventId: string): Promise<JoinTokenDto> {
  const access = await loadAccess(deps, user, eventId);
  const { event, member } = access;
  if (!member) throw forbidden('Only event members can join');
  await enforceRateLimit(deps, 'joinToken', user.userId);

  const host = isHostRole(member.role);
  const joinable = host ? ['READY', 'LIVE'] : ['LIVE'];
  if (!joinable.includes(event.status)) {
    throw new AppError(409, 'EVENT_NOT_LIVE', `The event is ${event.status.toLowerCase()}`, { status: event.status });
  }

  const now = deps.now();
  const admission = await deps.store.admitParticipant(
    eventId,
    user.userId,
    member.role,
    event.maxParticipants,
    now.toISOString(),
  );
  if (admission.status === 'full') {
    await audit(deps, `EVENT#${eventId}`, 'join.rejected_full', user.userId, eventId);
    throw new AppError(409, 'EVENT_FULL', 'This event has reached its participant limit');
  }

  const open = await deps.store.getOpenSpeakerRequest(eventId, user.userId);
  const speaker = open?.status === 'APPROVED';
  const grant = grantFor(member.role, speaker);
  const ttl = deps.config.joinTokenTtlSeconds;
  const token = await deps.livekit.createToken({
    roomName: event.roomName,
    identity: user.userId,
    name: member.displayName,
    metadata: participantMetadata(member.role, member.displayName, speaker),
    grant,
    ttlSeconds: ttl,
  });
  if (admission.status === 'admitted') {
    await audit(deps, `EVENT#${eventId}`, 'join.admitted', user.userId, eventId, { role: member.role });
  }
  return {
    serverUrl: deps.livekit.serverUrl,
    token,
    roomName: event.roomName,
    identity: user.userId,
    role: member.role,
    canPublish: grant.canPublish,
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
  };
}

export async function leaveEvent(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  const now = deps.now().toISOString();
  await releaseUser(deps, access.event, user.userId, user.userId, now);
}

/** Frees the user's capacity slot and any speaker slot / pending hand. Idempotent. */
export async function releaseUser(deps: AppDeps, event: EventRecord, userId: string, actorId: string, now: string) {
  const released = await deps.store.releaseParticipant(event.id, userId, now);
  const open = await deps.store.getOpenSpeakerRequest(event.id, userId);
  if (open?.status === 'APPROVED') {
    await deps.store.revokeSpeaker(event.id, userId, actorId, now);
    await notifyResolved(deps, event, { ...open, status: 'REVOKED' });
  } else if (open?.status === 'PENDING') {
    await deps.store.closePendingSpeakerRequest(event.id, open.id, 'CANCELLED', actorId, now);
    await notifyResolved(deps, event, { ...open, status: 'CANCELLED' });
  }
  return released;
}

async function notifyResolved(deps: AppDeps, event: EventRecord, request: SpeakerRequestRecord) {
  const mods = await moderatorIdentities(deps, event.id);
  await broadcast(
    deps,
    event,
    { type: 'speaker_request_resolved', requestId: request.id, userId: request.userId, status: request.status },
    DATA_TOPICS.moderation,
    mods,
  );
}

export async function raiseHand(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  const { event, member } = access;
  if (!member) throw forbidden('Only event members can raise their hand');
  if (member.role !== 'VIEWER') throw conflict('ALREADY_HOST', 'Hosts can already speak');
  requireLive(event);
  if (event.maxSpeakers === 0) throw conflict('SPEAKERS_DISABLED', 'Audience speaking is disabled for this event');
  await enforceRateLimit(deps, 'raiseHand', user.userId);

  const session = await deps.store.getParticipantSession(eventId, user.userId);
  if (!session || session.state === 'LEFT') throw conflict('NOT_IN_ROOM', 'Join the event before raising your hand');

  const { created, request } = await deps.store.createSpeakerRequest({
    id: newId(),
    eventId,
    userId: user.userId,
    displayName: member.displayName,
    status: 'PENDING',
    createdAt: deps.now().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
  });
  if (created) {
    const mods = await moderatorIdentities(deps, eventId);
    await broadcast(deps, event, { type: 'speaker_request', request: toSpeakerRequestDto(request) }, DATA_TOPICS.moderation, mods);
    await audit(deps, `EVENT#${eventId}`, 'hand.raised', user.userId, request.id);
  }
  return toSpeakerRequestDto(request);
}

export async function lowerHand(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  const open = await deps.store.getOpenSpeakerRequest(eventId, user.userId);
  if (!open) return;
  const now = deps.now().toISOString();
  if (open.status === 'PENDING') {
    await deps.store.closePendingSpeakerRequest(eventId, open.id, 'CANCELLED', user.userId, now);
    await notifyResolved(deps, access.event, { ...open, status: 'CANCELLED' });
  } else if (open.status === 'APPROVED') {
    // A speaker stepping down voluntarily.
    await demote(deps, access.event, user.userId, user.userId);
  }
}

export async function listSpeakerRequests(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireModerate(access);
  const items = await deps.store.listSpeakerRequests(eventId);
  return { items: items.filter((r) => r.status === 'PENDING' || r.status === 'APPROVED').map(toSpeakerRequestDto) };
}

export async function approveSpeaker(deps: AppDeps, user: AuthUser, eventId: string, requestId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireModerate(access);
  const { event } = access;
  requireLive(event);
  const request = await deps.store.getSpeakerRequest(eventId, requestId);
  if (!request) throw notFound('Speaker request');
  if (request.status === 'APPROVED') return toSpeakerRequestDto(request); // idempotent

  const now = deps.now().toISOString();
  const [member, session] = await Promise.all([
    deps.store.getMember(eventId, request.userId),
    deps.store.getParticipantSession(eventId, request.userId),
  ]);
  if (!member || member.status !== 'ACTIVE' || !session || session.state === 'LEFT') {
    await deps.store.closePendingSpeakerRequest(eventId, requestId, 'CANCELLED', user.userId, now);
    throw conflict('PARTICIPANT_NOT_CONNECTED', 'The participant is no longer in the event');
  }

  const result = await deps.store.approveSpeakerRequest(eventId, requestId, event.maxSpeakers, user.userId, now);
  if (result.status === 'speaker_limit') {
    throw conflict('SPEAKER_LIMIT', `The stage is full (${event.maxSpeakers} speakers). Remove a speaker first.`);
  }
  if (result.status === 'not_pending') {
    if (result.request?.status === 'APPROVED') return toSpeakerRequestDto(result.request);
    throw conflict('REQUEST_NOT_PENDING', 'This request was already handled');
  }

  try {
    await deps.livekit.updateParticipant(
      event.roomName,
      request.userId,
      grantFor(member.role, true),
      participantMetadata(member.role, member.displayName, true),
    );
  } catch (err) {
    // Keep DynamoDB and LiveKit consistent: undo the slot if LiveKit refused the change.
    await deps.store.revokeSpeaker(eventId, request.userId, 'system', deps.now().toISOString());
    deps.logger.error('livekit promote failed', { eventId, requestId, err });
    throw new AppError(502, 'LIVEKIT_ERROR', 'Could not update participant permissions; try again');
  }

  await broadcast(deps, event, { type: 'speaker_approved', requestId }, DATA_TOPICS.speaker, [request.userId]);
  await notifyResolved(deps, event, result.request);
  await audit(deps, `EVENT#${eventId}`, 'speaker.approved', user.userId, request.userId, { requestId });
  await deps.bus.publish({ type: 'SpeakerApproved', detail: { eventId, userId: request.userId } });
  return toSpeakerRequestDto(result.request);
}

export async function rejectSpeaker(deps: AppDeps, user: AuthUser, eventId: string, requestId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireModerate(access);
  const closed = await deps.store.closePendingSpeakerRequest(
    eventId,
    requestId,
    'REJECTED',
    user.userId,
    deps.now().toISOString(),
  );
  if (!closed) {
    const current = await deps.store.getSpeakerRequest(eventId, requestId);
    if (!current) throw notFound('Speaker request');
    if (current.status === 'REJECTED') return toSpeakerRequestDto(current);
    throw conflict('REQUEST_NOT_PENDING', 'This request was already handled');
  }
  await broadcast(
    deps,
    access.event,
    { type: 'speaker_request_resolved', requestId, userId: closed.userId, status: 'REJECTED' },
    DATA_TOPICS.speaker,
    [closed.userId],
  );
  await notifyResolved(deps, access.event, closed);
  await audit(deps, `EVENT#${eventId}`, 'speaker.rejected', user.userId, closed.userId, { requestId });
  return toSpeakerRequestDto(closed);
}

export async function demoteSpeaker(deps: AppDeps, user: AuthUser, eventId: string, userId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireModerate(access);
  const revoked = await demote(deps, access.event, userId, user.userId);
  if (!revoked) throw notFound('Active speaker');
}

async function demote(deps: AppDeps, event: EventRecord, userId: string, actorId: string) {
  const now = deps.now().toISOString();
  const revoked = await deps.store.revokeSpeaker(event.id, userId, actorId, now);
  if (!revoked) return null;
  const member = await deps.store.getMember(event.id, userId);
  const role = member?.role ?? 'VIEWER';
  // Revoking canPublish makes LiveKit unpublish the participant's tracks server-side.
  await deps.livekit.updateParticipant(
    event.roomName,
    userId,
    grantFor(role, false),
    participantMetadata(role, member?.displayName ?? revoked.displayName, false),
  );
  await broadcast(deps, event, { type: 'speaker_revoked' }, DATA_TOPICS.speaker, [userId]);
  await notifyResolved(deps, event, revoked);
  await audit(deps, `EVENT#${event.id}`, 'speaker.revoked', actorId, userId);
  return revoked;
}

/** Moderator removes a participant from the live room (not from the event). */
export async function kickParticipant(deps: AppDeps, user: AuthUser, eventId: string, userId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireModerate(access);
  const target = await deps.store.getMember(eventId, userId);
  if (target?.role === 'ORGANIZER') throw forbidden('The organizer cannot be removed');
  await deps.livekit.removeParticipant(access.event.roomName, userId);
  await releaseUser(deps, access.event, userId, user.userId, deps.now().toISOString());
  await audit(deps, `EVENT#${eventId}`, 'participant.kicked', user.userId, userId);
}
