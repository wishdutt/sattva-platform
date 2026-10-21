import { DATA_TOPICS, LIMITS, type RecordingDto } from '@lsp/shared';
import type { AuthUser } from '../auth/verifier';
import type { AppDeps } from '../deps';
import { AppError, ConditionFailedError, conflict, forbidden, notFound } from '../lib/errors';
import { newId } from '../lib/ids';
import type { EventRecord, RecordingRecord } from '../store/types';
import { audit, broadcast, loadAccess, requireManage } from './access';

async function toDto(deps: AppDeps, r: RecordingRecord, withUrl: boolean): Promise<RecordingDto> {
  return {
    id: r.id,
    eventId: r.eventId,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationSeconds: r.durationSeconds,
    sizeBytes: r.sizeBytes,
    playbackUrl:
      withUrl && r.status === 'READY'
        ? await deps.storage.presignGet(r.s3Key, LIMITS.playbackUrlTtlSeconds, `${r.eventId}-${r.id}.mp4`)
        : null,
  };
}

export async function startRecording(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireManage(access);
  const { event } = access;
  if (!event.recordingEnabled) throw conflict('RECORDING_DISABLED', 'Recording is not enabled for this event');
  if (event.status !== 'LIVE') throw conflict('EVENT_NOT_LIVE', 'Recording can only start while the event is live');

  const now = deps.now().toISOString();
  const recording: RecordingRecord = {
    id: newId(),
    eventId,
    egressId: null,
    status: 'STARTING',
    s3Key: `recordings/${eventId}/${newId()}.mp4`,
    startedBy: user.userId,
    startedAt: now,
    endedAt: null,
    durationSeconds: null,
    sizeBytes: null,
    error: null,
  };
  try {
    await deps.store.createRecording(recording);
  } catch (err) {
    if (err instanceof ConditionFailedError) throw conflict('RECORDING_ACTIVE', 'A recording is already in progress');
    throw err;
  }

  try {
    const creds = await deps.egressCredentials();
    const { egressId } = await deps.livekit.startRecording(event.roomName, {
      filepath: recording.s3Key,
      s3: { bucket: deps.config.mediaBucket, region: deps.config.region, ...creds },
    });
    const updated = await deps.store.updateRecording(eventId, recording.id, { egressId });
    await broadcast(deps, event, { type: 'recording', active: true }, DATA_TOPICS.system);
    await audit(deps, `EVENT#${eventId}`, 'recording.started', user.userId, recording.id, { egressId });
    return toDto(deps, updated, false);
  } catch (err) {
    await deps.store.updateRecording(eventId, recording.id, { status: 'FAILED', error: 'egress start failed', endedAt: now });
    await deps.store.updateEvent(eventId, { activeRecordingId: null }, { ifActiveRecordingId: recording.id }).catch(() => undefined);
    deps.logger.error('egress start failed', { eventId, err });
    throw new AppError(502, 'RECORDING_START_FAILED', 'Could not start recording');
  }
}

/** Stops the active egress, if any. Used by stop endpoint and by endEvent. */
export async function stopActiveRecording(deps: AppDeps, event: EventRecord, actorId: string) {
  if (!event.activeRecordingId) return null;
  const recording = await deps.store.getRecording(event.id, event.activeRecordingId);
  const now = deps.now().toISOString();
  if (recording?.egressId && ['STARTING', 'ACTIVE'].includes(recording.status)) {
    try {
      await deps.livekit.stopRecording(recording.egressId);
    } catch (err) {
      deps.logger.warn('egress stop failed (may already be stopped)', { egressId: recording.egressId, err });
    }
  }
  const updated = recording
    ? await deps.store.updateRecording(event.id, recording.id, {
        status: recording.status === 'READY' ? 'READY' : 'ENDING',
        endedAt: now,
      })
    : null;
  await deps.store
    .updateEvent(event.id, { activeRecordingId: null }, { ifActiveRecordingId: event.activeRecordingId })
    .catch(() => undefined);
  await broadcast(deps, event, { type: 'recording', active: false }, DATA_TOPICS.system);
  await audit(deps, `EVENT#${event.id}`, 'recording.stopped', actorId, event.activeRecordingId);
  return updated;
}

export async function stopRecording(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireManage(access);
  const stopped = await stopActiveRecording(deps, access.event, user.userId);
  if (!stopped) throw conflict('NO_ACTIVE_RECORDING', 'No recording is in progress');
  return toDto(deps, stopped, false);
}

export async function listRecordings(deps: AppDeps, user: AuthUser, eventId: string) {
  const access = await loadAccess(deps, user, eventId);
  if (!access.member && !access.isAdmin) throw forbidden();
  const items = (await deps.store.listRecordings(eventId)).filter((r) => r.status !== 'DELETED');
  // Members may replay; presigned URLs are short-lived and generated per request.
  return { items: await Promise.all(items.map((r) => toDto(deps, r, true))) };
}

export async function deleteRecording(deps: AppDeps, user: AuthUser, eventId: string, recordingId: string) {
  const access = await loadAccess(deps, user, eventId);
  requireManage(access);
  const recording = await deps.store.getRecording(eventId, recordingId);
  if (!recording || recording.status === 'DELETED') throw notFound('Recording');
  if (['STARTING', 'ACTIVE'].includes(recording.status)) {
    throw conflict('RECORDING_ACTIVE', 'Stop the recording before deleting it');
  }
  await deps.storage.delete(recording.s3Key);
  await deps.store.updateRecording(eventId, recordingId, { status: 'DELETED' });
  await audit(deps, `EVENT#${eventId}`, 'recording.deleted', user.userId, recordingId);
}
