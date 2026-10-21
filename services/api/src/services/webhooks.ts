import type { AppDeps } from '../deps';
import { AppError } from '../lib/errors';
import type { NormalizedWebhookEvent } from '../integrations/livekit';
import { audit } from './access';
import { releaseUser } from './live';

const eventIdFromRoom = (roomName?: string) => (roomName?.startsWith('evt-') ? roomName.slice(4) : null);

/**
 * Handles a LiveKit webhook. The signature (JWT over the body's sha256) is verified first;
 * unverifiable requests are rejected with 401 and never touch state.
 */
export async function handleLiveKitWebhook(deps: AppDeps, body: string, authorization: string | undefined) {
  let evt: NormalizedWebhookEvent;
  try {
    evt = await deps.livekit.verifyWebhook(body, authorization);
  } catch (err) {
    deps.logger.warn('rejected livekit webhook', { err: (err as Error).message });
    throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
  }

  // Webhooks are delivered at-least-once; every branch below is idempotent.
  const log = deps.logger.child({ webhook: evt.event, webhookId: evt.id });
  const now = deps.now().toISOString();
  const eventId = eventIdFromRoom(evt.roomName);

  switch (evt.event) {
    case 'participant_joined': {
      if (!eventId || !evt.participantIdentity) break;
      if (evt.participantIdentity.startsWith('EG_')) break; // egress recorder
      const [event, member, session] = await Promise.all([
        deps.store.getEvent(eventId),
        deps.store.getMember(eventId, evt.participantIdentity),
        deps.store.getParticipantSession(eventId, evt.participantIdentity),
      ]);
      let admitted = !!session && session.state !== 'LEFT';
      if (event && member?.status === 'ACTIVE' && !admitted) {
        // A client-side full reconnect (same token, new SID) arrives after our "left" handling:
        // re-admit through the normal capacity check instead of kicking a legitimate member.
        const result = await deps.store.admitParticipant(eventId, member.userId, member.role, event.maxParticipants, now);
        admitted = result.status !== 'full';
      }
      // Defense in depth: anyone in the room without an active membership and admission is removed.
      if (!event || member?.status !== 'ACTIVE' || !admitted) {
        log.warn('removing unadmitted participant', { eventId, identity: evt.participantIdentity });
        await deps.livekit.removeParticipant(evt.roomName!, evt.participantIdentity);
        await audit(deps, `EVENT#${eventId}`, 'participant.unadmitted_removed', null, evt.participantIdentity);
        break;
      }
      await deps.store.markParticipantConnected(eventId, evt.participantIdentity, evt.participantSid ?? '', now);
      break;
    }
    case 'participant_left':
    case 'participant_connection_aborted': {
      if (!eventId || !evt.participantIdentity) break;
      const event = await deps.store.getEvent(eventId);
      if (!event) break;
      const session = await deps.store.getParticipantSession(eventId, evt.participantIdentity);
      // Ignore a late "left" for an older connection if the user has already reconnected with a new SID.
      if (session?.livekitSid && evt.participantSid && session.livekitSid !== evt.participantSid) break;
      await releaseUser(deps, event, evt.participantIdentity, 'system', now);
      break;
    }
    case 'room_finished': {
      if (!eventId) break;
      const sessions = await deps.store.listParticipantSessions(eventId);
      const event = await deps.store.getEvent(eventId);
      if (!event) break;
      for (const s of sessions.filter((x) => x.state !== 'LEFT')) {
        await releaseUser(deps, event, s.userId, 'system', now);
      }
      break;
    }
    case 'egress_started':
    case 'egress_updated':
    case 'egress_ended': {
      if (!evt.egress) break;
      const recording = await deps.store.getRecordingByEgressId(evt.egress.egressId);
      if (!recording || recording.status === 'DELETED') break;
      const { status } = evt.egress;
      if (status === 'active' && recording.status === 'STARTING') {
        await deps.store.updateRecording(recording.eventId, recording.id, { status: 'ACTIVE' });
      } else if (status === 'complete') {
        await deps.store.updateRecording(recording.eventId, recording.id, {
          status: 'READY',
          endedAt: recording.endedAt ?? now,
          durationSeconds: evt.egress.durationSeconds ?? null,
          sizeBytes: evt.egress.sizeBytes ?? null,
        });
        await deps.store
          .updateEvent(recording.eventId, { activeRecordingId: null }, { ifActiveRecordingId: recording.id })
          .catch(() => undefined);
        await deps.bus.publish({ type: 'RecordingReady', detail: { eventId: recording.eventId, recordingId: recording.id } });
      } else if (status === 'failed' || status === 'aborted') {
        await deps.store.updateRecording(recording.eventId, recording.id, {
          status: 'FAILED',
          endedAt: now,
          error: evt.egress.error?.slice(0, 500) ?? status,
        });
        await deps.store
          .updateEvent(recording.eventId, { activeRecordingId: null }, { ifActiveRecordingId: recording.id })
          .catch(() => undefined);
        log.error('recording failed', { recordingId: recording.id, error: evt.egress.error });
      }
      break;
    }
    default:
      log.debug('ignored webhook');
  }
  return { ok: true };
}
