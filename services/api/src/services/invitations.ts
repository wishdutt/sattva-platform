import {
  acceptInvitationSchema,
  inviteSchema,
  updateMemberSchema,
  type InvitationDto,
  type InvitationPreviewDto,
  type MemberDto,
} from '@lsp/shared';
import type { AuthUser } from '../auth/verifier';
import type { AppDeps } from '../deps';
import { AppError, ConditionFailedError, conflict, forbidden, notFound } from '../lib/errors';
import { newId, newInvitationToken, sha256 } from '../lib/ids';
import type { EventRecord, InvitationRecord, MemberRecord } from '../store/types';
import { audit, enforceRateLimit, grantFor, loadAccess, participantMetadata, requireManage } from './access';
import { parse } from './validate';

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function toInvitationDto(inv: InvitationRecord, now: string): InvitationDto {
  return {
    id: inv.id,
    eventId: inv.eventId,
    email: inv.email,
    role: inv.role,
    status: inv.status === 'PENDING' && inv.expiresAt <= now ? 'EXPIRED' : inv.status,
    invitedBy: inv.invitedBy,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt,
  };
}

export const toMemberDto = (m: MemberRecord): MemberDto => ({
  eventId: m.eventId,
  userId: m.userId,
  email: m.email,
  displayName: m.displayName,
  role: m.role,
  status: m.status,
  canModerate: m.role === 'ORGANIZER' || m.canModerate,
  joinedAt: m.joinedAt,
});

function inviteEmail(event: EventRecord, link: string, inviterName: string, role: string, message?: string) {
  const when = new Date(event.startAt).toUTCString();
  const roleLine = role === 'BROADCASTER' ? 'as a broadcaster' : 'to attend';
  const text = [
    `${inviterName} invited you ${roleLine}: ${event.title}`,
    `Starts: ${when}`,
    message ? `\n"${message}"\n` : '',
    `Accept your invitation (sign in or create an account with this email address):`,
    link,
    '',
    'This link is personal, single-use and expires. If you were not expecting it, ignore this email.',
  ].join('\n');
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a">
  <h2 style="margin:0 0 8px">${escapeHtml(event.title)}</h2>
  <p>${escapeHtml(inviterName)} invited you ${roleLine}.</p>
  <p><strong>Starts:</strong> ${escapeHtml(when)}</p>
  ${message ? `<blockquote style="border-left:3px solid #6366f1;padding-left:12px;color:#334155">${escapeHtml(message)}</blockquote>` : ''}
  <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Accept invitation</a></p>
  <p style="font-size:12px;color:#64748b">Sign in or create an account using this email address. The link is personal, single-use and expires.</p>
  </body></html>`;
  return { subject: `Invitation: ${event.title}`, text, html };
}

export async function inviteParticipants(deps: AppDeps, user: AuthUser, eventId: string, body: unknown) {
  const access = await loadAccess(deps, user, eventId);
  requireManage(access);
  if (['ENDED', 'CANCELLED'].includes(access.event.status)) throw conflict('EVENT_CLOSED', 'Event is closed');
  const input = parse(inviteSchema, body);
  await enforceRateLimit(deps, 'invite', user.userId);

  const now = deps.now();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + deps.config.invitationTtlHours * 3_600_000).toISOString();

  // Skip addresses that are already active members or have a live pending invitation.
  const [members, existing] = await Promise.all([deps.store.listMembers(eventId), deps.store.listInvitations(eventId)]);
  const activeEmails = new Set(members.filter((m) => m.status === 'ACTIVE').map((m) => m.email));
  const pendingEmails = new Set(
    existing.filter((i) => i.status === 'PENDING' && i.expiresAt > nowIso).map((i) => i.email),
  );
  const targets = input.emails.filter((e) => !activeEmails.has(e) && !pendingEmails.has(e));

  const created: { record: InvitationRecord; token: string }[] = targets.map((email) => {
    const token = newInvitationToken();
    return {
      token,
      record: {
        id: newId(),
        eventId,
        email,
        role: input.role,
        status: 'PENDING',
        tokenHash: sha256(token),
        invitedBy: user.userId,
        createdAt: nowIso,
        expiresAt,
        acceptedAt: null,
        acceptedBy: null,
      },
    };
  });
  if (created.length) await deps.store.createInvitations(created.map((c) => c.record));

  const failures: string[] = [];
  for (const { record, token } of created) {
    const link = `${deps.config.webBaseUrl}/invite?token=${encodeURIComponent(token)}`;
    try {
      await deps.mailer.send({ to: record.email, ...inviteEmail(access.event, link, user.displayName, record.role, input.message) });
    } catch (err) {
      failures.push(record.email);
      deps.logger.error('invitation email failed', { invitationId: record.id, err });
    }
  }
  await audit(deps, `EVENT#${eventId}`, 'invitations.created', user.userId, eventId, {
    count: created.length,
    skipped: input.emails.length - created.length,
    role: input.role,
  });
  return {
    items: created.map((c) => toInvitationDto(c.record, nowIso)),
    skipped: input.emails.filter((e) => !targets.includes(e)),
    emailFailures: failures,
  };
}

export async function listInvitations(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireManage(access);
  const now = deps.now().toISOString();
  const items = await deps.store.listInvitations(eventId);
  return { items: items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((i) => toInvitationDto(i, now)) };
}

export async function revokeInvitation(deps: AppDeps, user: AuthUser, eventId: string, invitationId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireManage(access);
  try {
    await deps.store.setInvitationStatus(eventId, invitationId, 'REVOKED', 'PENDING');
  } catch (err) {
    if (err instanceof ConditionFailedError) throw conflict('INVITATION_NOT_PENDING', 'Invitation is no longer pending');
    throw err;
  }
  await audit(deps, `EVENT#${eventId}`, 'invitation.revoked', user.userId, invitationId);
}

async function resolveInvitation(deps: AppDeps, user: AuthUser, token: string) {
  const invitation = await deps.store.getInvitationByTokenHash(sha256(token));
  // Do not reveal whether a token exists for a different email.
  if (!invitation) throw notFound('Invitation');
  const now = deps.now().toISOString();
  if (invitation.status === 'REVOKED') throw new AppError(410, 'INVITATION_REVOKED', 'This invitation was revoked');
  if (invitation.status === 'ACCEPTED') {
    if (invitation.acceptedBy === user.userId) return { invitation, alreadyAccepted: true };
    throw new AppError(410, 'INVITATION_USED', 'This invitation has already been used');
  }
  if (invitation.expiresAt <= now) throw new AppError(410, 'INVITATION_EXPIRED', 'This invitation has expired');
  if (!user.emailVerified) throw forbidden('Verify your email address before accepting invitations');
  if (invitation.email !== user.email) {
    throw forbidden('This invitation was sent to a different email address. Sign in with the invited address.');
  }
  return { invitation, alreadyAccepted: false };
}

export async function previewInvitation(deps: AppDeps, user: AuthUser, body: unknown): Promise<InvitationPreviewDto> {
  const { token } = parse(acceptInvitationSchema, body);
  const { invitation } = await resolveInvitation(deps, user, token);
  const event = await deps.store.getEvent(invitation.eventId);
  if (!event) throw notFound('Event');
  return { eventId: event.id, eventTitle: event.title, role: invitation.role };
}

export async function acceptInvitation(deps: AppDeps, user: AuthUser, body: unknown) {
  const { token } = parse(acceptInvitationSchema, body);
  const { invitation, alreadyAccepted } = await resolveInvitation(deps, user, token);
  if (alreadyAccepted) return { eventId: invitation.eventId, role: invitation.role };

  const event = await deps.store.getEvent(invitation.eventId);
  if (!event || ['ENDED', 'CANCELLED'].includes(event.status)) {
    throw new AppError(410, 'EVENT_CLOSED', 'This event is no longer available');
  }
  const existing = await deps.store.getMember(event.id, user.userId);
  const now = deps.now().toISOString();
  // Never downgrade an existing organizer/broadcaster through an invitation.
  const role = existing?.status === 'ACTIVE' && existing.role !== 'VIEWER' ? existing.role : invitation.role;
  const member: MemberRecord = {
    eventId: event.id,
    userId: user.userId,
    email: user.email,
    displayName: user.displayName,
    role,
    status: 'ACTIVE',
    canModerate: existing?.canModerate ?? role === 'BROADCASTER',
    eventStartAt: event.startAt,
    joinedAt: existing?.joinedAt ?? now,
    updatedAt: now,
  };
  try {
    await deps.store.acceptInvitation(invitation, member, now);
  } catch (err) {
    if (err instanceof ConditionFailedError) {
      throw new AppError(410, 'INVITATION_USED', 'This invitation is no longer valid');
    }
    throw err;
  }
  await audit(deps, `EVENT#${event.id}`, 'invitation.accepted', user.userId, invitation.id);
  await deps.bus.publish({ type: 'InvitationAccepted', detail: { eventId: event.id, userId: user.userId } });
  return { eventId: event.id, role };
}

export async function listMembers(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  if (!access.canModerate) throw forbidden('Moderator permission required');
  const members = await deps.store.listMembers(eventId);
  return { items: members.filter((m) => m.status === 'ACTIVE').map(toMemberDto) };
}

export async function updateMember(deps: AppDeps, user: AuthUser, eventId: string, userId: string, body: unknown) {
  const access = await loadAccess(deps, user, eventId);
  requireManage(access);
  const input = parse(updateMemberSchema, body);
  const member = await deps.store.getMember(eventId, userId);
  if (!member || member.status !== 'ACTIVE') throw notFound('Member');
  if (member.role === 'ORGANIZER') throw conflict('CANNOT_CHANGE_ORGANIZER', 'The organizer role cannot be changed');

  const updated: MemberRecord = {
    ...member,
    role: input.role ?? member.role,
    canModerate: input.canModerate ?? (input.role === 'BROADCASTER' ? true : input.role === 'VIEWER' ? false : member.canModerate),
    updatedAt: deps.now().toISOString(),
  };
  await deps.store.putMember(updated);

  // Apply the new grant to a live connection immediately (server-authoritative).
  if (updated.role !== member.role && ['READY', 'LIVE'].includes(access.event.status)) {
    const open = await deps.store.getOpenSpeakerRequest(eventId, userId);
    const speaker = open?.status === 'APPROVED';
    await deps.livekit.updateParticipant(
      access.event.roomName,
      userId,
      grantFor(updated.role, speaker),
      participantMetadata(updated.role, updated.displayName, speaker),
    );
  }
  await audit(deps, `EVENT#${eventId}`, 'member.updated', user.userId, userId, input);
  return toMemberDto(updated);
}

export async function removeMember(deps: AppDeps, user: AuthUser, eventId: string, userId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireManage(access);
  const member = await deps.store.getMember(eventId, userId);
  if (!member || member.status !== 'ACTIVE') throw notFound('Member');
  if (member.role === 'ORGANIZER') throw conflict('CANNOT_REMOVE_ORGANIZER', 'The organizer cannot be removed');
  const now = deps.now().toISOString();

  // Order matters: revoke membership first so a reconnect with a fresh token is refused,
  // then kick the live connection (an already-issued token can still be valid until expiry).
  await deps.store.putMember({ ...member, status: 'REMOVED', updatedAt: now });
  await deps.store.revokeSpeaker(eventId, userId, user.userId, now);
  const open = await deps.store.getOpenSpeakerRequest(eventId, userId);
  if (open?.status === 'PENDING') await deps.store.closePendingSpeakerRequest(eventId, open.id, 'CANCELLED', user.userId, now);
  await deps.livekit.removeParticipant(access.event.roomName, userId);
  await deps.store.releaseParticipant(eventId, userId, now);
  // Also revoke any outstanding invitation for the same address.
  const invitations = await deps.store.listInvitations(eventId);
  await Promise.all(
    invitations
      .filter((i) => i.email === member.email && i.status === 'PENDING')
      .map((i) => deps.store.setInvitationStatus(eventId, i.id, 'REVOKED', 'PENDING').catch(() => undefined)),
  );
  await audit(deps, `EVENT#${eventId}`, 'member.removed', user.userId, userId);
}
