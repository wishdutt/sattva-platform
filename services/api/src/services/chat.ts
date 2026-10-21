import { DATA_TOPICS, chatMessageSchema, reactionSchema, type ChatMessageDto } from '@lsp/shared';
import type { AuthUser } from '../auth/verifier';
import type { AppDeps } from '../deps';
import { conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import type { ChatMessageRecord } from '../store/types';
import { audit, broadcast, enforceRateLimit, loadAccess, requireModerate } from './access';
import { parse } from './validate';

const toDto = (m: ChatMessageRecord): ChatMessageDto => ({
  id: m.id,
  eventId: m.eventId,
  userId: m.userId,
  displayName: m.displayName,
  role: m.role,
  text: m.deleted ? '' : m.text,
  createdAt: m.createdAt,
  deleted: m.deleted,
});

export async function sendChat(deps: AppDeps, user: AuthUser, eventId: string, body: unknown) {
  const access = await loadAccess(deps, user, eventId);
  const { event, member } = access;
  if (!member) throw forbidden('Only event members can chat');
  if (!['READY', 'LIVE'].includes(event.status)) throw conflict('EVENT_NOT_LIVE', 'Chat is open only during the event');
  if (!event.chatEnabled && !access.canModerate) throw conflict('CHAT_DISABLED', 'Chat is disabled by the organizer');
  const { text } = parse(chatMessageSchema, body);
  await enforceRateLimit(deps, 'chat', `${eventId}#${user.userId}`);

  const now = deps.now();
  // Sender identity, name and role come from the verified token + membership — never from the client.
  const message: ChatMessageRecord = {
    id: newId(),
    eventId,
    userId: user.userId,
    displayName: member.displayName,
    role: member.role,
    text,
    createdAt: now.toISOString(),
    deleted: false,
    deletedBy: null,
    ttl: Math.floor(now.getTime() / 1000) + deps.config.chatRetentionDays * 86_400,
  };
  if (event.chatPersistence) await deps.store.putChatMessage(message);
  const dto = toDto(message);
  await broadcast(deps, event, { type: 'chat', message: dto }, DATA_TOPICS.chat);
  return dto;
}

export async function listChat(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  if (!access.member && !access.isAdmin) throw forbidden();
  const items = await deps.store.listChatMessages(eventId, 100);
  return { items: items.map(toDto) };
}

export async function deleteChat(deps: AppDeps, user: AuthUser, eventId: string, messageId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireModerate(access);
  const ok = await deps.store.markChatMessageDeleted(eventId, messageId, user.userId);
  // Non-persisted messages cannot be found, but clients still remove them from view.
  if (!ok && access.event.chatPersistence) throw notFound('Message');
  await broadcast(deps, access.event, { type: 'chat_deleted', messageId }, DATA_TOPICS.chat);
  await audit(deps, `EVENT#${eventId}`, 'chat.deleted', user.userId, messageId);
}

export async function sendReaction(deps: AppDeps, user: AuthUser, eventId: string, body: unknown) {
  const access = await loadAccess(deps, user, eventId);
  if (!access.member) throw forbidden('Only event members can react');
  if (access.event.status !== 'LIVE') throw conflict('EVENT_NOT_LIVE', 'The event is not live');
  const { emoji } = parse(reactionSchema, body);
  await enforceRateLimit(deps, 'reaction', `${eventId}#${user.userId}`);
  await broadcast(
    deps,
    access.event,
    { type: 'reaction', emoji, userId: user.userId, displayName: access.member.displayName },
    DATA_TOPICS.reaction,
  );
}
