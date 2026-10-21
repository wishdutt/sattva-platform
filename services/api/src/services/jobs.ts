import type { AppDeps } from '../deps';
import type { EventRecord } from '../store/types';
import { audit } from './access';
import { releaseUser } from './live';

const isHost = (role: string) => role === 'ORGANIZER' || role === 'BROADCASTER';

/**
 * Reconciles DynamoDB participant state with LiveKit's actual room membership.
 * Repairs: missed participant_left webhooks, admissions that never connected,
 * members removed while connected, and drifted counters.
 */
export async function reconcileEvent(deps: AppDeps, event: EventRecord) {
  const now = deps.now();
  const nowIso = now.toISOString();
  const graceMs = deps.config.admissionGraceSeconds * 1000;
  const [inRoom, sessions, members] = await Promise.all([
    deps.livekit.listParticipants(event.roomName),
    deps.store.listParticipantSessions(event.id),
    deps.store.listMembers(event.id),
  ]);
  const present = new Set(inRoom.map((p) => p.identity));
  const activeMembers = new Set(members.filter((m) => m.status === 'ACTIVE').map((m) => m.userId));
  let released = 0;
  let removed = 0;

  for (const s of sessions) {
    if (s.state === 'LEFT') continue;
    const staleAdmission = s.state === 'ADMITTED' && now.getTime() - new Date(s.admittedAt).getTime() > graceMs;
    const disconnected = s.state === 'CONNECTED' && !present.has(s.userId);
    if ((staleAdmission && !present.has(s.userId)) || disconnected) {
      await releaseUser(deps, event, s.userId, 'reconciler', nowIso);
      released++;
    }
  }
  for (const p of inRoom) {
    if (p.identity.startsWith('EG_')) continue;
    if (!activeMembers.has(p.identity)) {
      await deps.livekit.removeParticipant(event.roomName, p.identity);
      removed++;
    }
  }

  // Recompute counters from the authoritative per-user records.
  const fresh = await deps.store.listParticipantSessions(event.id);
  const open = fresh.filter((s) => s.state !== 'LEFT');
  const requests = await deps.store.listSpeakerRequests(event.id);
  const capacity = {
    eventId: event.id,
    total: open.length,
    hosts: open.filter((s) => isHost(s.role)).length,
    speakers: requests.filter((r) => r.status === 'APPROVED').length,
  };
  const current = await deps.store.getCapacity(event.id);
  if (current.total !== capacity.total || current.hosts !== capacity.hosts || current.speakers !== capacity.speakers) {
    deps.logger.warn('capacity drift corrected', { eventId: event.id, before: current, after: capacity });
    await deps.store.resetCapacity(capacity);
  }
  if (released || removed) {
    await audit(deps, `EVENT#${event.id}`, 'reconcile', 'system', event.id, { released, removed });
  }
  return { released, removed, capacity };
}

export async function reconcileLiveEvents(deps: AppDeps) {
  const events = [...(await deps.store.listEventsByStatus('LIVE')), ...(await deps.store.listEventsByStatus('READY'))];
  const results = [];
  for (const event of events) {
    try {
      results.push({ eventId: event.id, ...(await reconcileEvent(deps, event)) });
    } catch (err) {
      deps.logger.error('reconcile failed', { eventId: event.id, err });
    }
  }
  return results;
}

/** Sends a push reminder ~15 minutes before scheduled events. Runs every 5 minutes. */
export async function sendUpcomingReminders(deps: AppDeps) {
  const now = deps.now().getTime();
  const windowStart = new Date(now + 10 * 60_000).toISOString();
  const windowEnd = new Date(now + 15 * 60_000).toISOString();
  const scheduled = await deps.store.listEventsByStatus('SCHEDULED');
  const due = scheduled.filter((e) => e.startAt > windowStart && e.startAt <= windowEnd);
  let sent = 0;
  for (const event of due) {
    const members = (await deps.store.listMembers(event.id)).filter((m) => m.status === 'ACTIVE');
    const devices = (await Promise.all(members.map((m) => deps.store.listDevices(m.userId)))).flat();
    const messages = devices
      .filter((d) => d.platform !== 'web')
      .map((d) => ({
        to: d.pushToken,
        title: 'Starting soon',
        body: `${event.title} starts in about 15 minutes`,
        data: { eventId: event.id },
      }));
    if (messages.length) {
      await deps.push.send(messages);
      sent += messages.length;
    }
  }
  return { events: due.length, sent };
}

/** Moves SCHEDULED events whose end time passed long ago to ENDED so dashboards stay accurate. */
export async function closeAbandonedEvents(deps: AppDeps) {
  const now = deps.now().getTime();
  let closed = 0;
  for (const status of ['SCHEDULED', 'READY', 'LIVE'] as const) {
    for (const e of await deps.store.listEventsByStatus(status)) {
      const end = new Date(e.startAt).getTime() + e.durationMinutes * 60_000;
      // LIVE events get a generous 6h overrun allowance before being force-ended.
      const allowance = status === 'LIVE' ? 6 * 3_600_000 : 24 * 3_600_000;
      if (now > end + allowance) {
        await deps.livekit.deleteRoom(e.roomName);
        await deps.store
          .updateEvent(e.id, { status: 'ENDED', endedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }, { ifStatusIn: [status] })
          .catch(() => undefined);
        closed++;
      }
    }
  }
  return { closed };
}
