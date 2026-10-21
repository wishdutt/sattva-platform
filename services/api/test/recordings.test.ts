import { describe, expect, it } from 'vitest';
import type { MockLiveKit } from '../src/integrations/livekit';
import { handleLiveKitWebhook } from '../src/services/webhooks';
import { TOKENS, createWorld } from './helpers';

async function liveEvent(recordingEnabled = true) {
  const w = createWorld();
  const id = await w.createEvent({ recordingEnabled });
  await w.addMember(id, TOKENS.viewer);
  await w.addMember(id, TOKENS.broadcaster, 'BROADCASTER');
  await w.goLive(id);
  return { w, id, lk: w.livekit as MockLiveKit };
}

const egressWebhook = (egressId: string, status: string) =>
  JSON.stringify({
    event: 'egress_ended',
    id: `EV_${Math.random()}`,
    createdAt: 0,
    egress: { egressId, status, durationSeconds: 120, sizeBytes: 1024 },
  });

describe('recording authorization', () => {
  it('only organizers can start recording', async () => {
    const { w, id } = await liveEvent();
    expect((await w.call('POST', `/events/${id}/recordings/start`, TOKENS.viewer, {})).status).toBe(403);
    expect((await w.call('POST', `/events/${id}/recordings/start`, TOKENS.broadcaster, {})).status).toBe(403);
    expect((await w.call('POST', `/events/${id}/recordings/start`, TOKENS.stranger, {})).status).toBe(404);
  });

  it('requires recording to be enabled and the event live', async () => {
    const { w, id } = await liveEvent(false);
    expect((await w.call('POST', `/events/${id}/recordings/start`, TOKENS.organizer, {})).body.error.code).toBe(
      'RECORDING_DISABLED',
    );
    const w2 = createWorld();
    const id2 = await w2.createEvent({ recordingEnabled: true });
    expect((await w2.call('POST', `/events/${id2}/recordings/start`, TOKENS.organizer, {})).body.error.code).toBe(
      'EVENT_NOT_LIVE',
    );
  });
});

describe('recording lifecycle', () => {
  it('starts egress to the private bucket, prevents duplicates, and stops', async () => {
    const { w, id, lk } = await liveEvent();
    const start = await w.call('POST', `/events/${id}/recordings/start`, TOKENS.organizer, {});
    expect(start.status).toBe(201);
    expect(start.body.status).toBe('STARTING');
    expect(start.body.playbackUrl).toBeNull();
    const call = lk.callsTo('startRecording')[0]!;
    expect(call.args[0]).toBe(`evt-${id}`);
    expect(call.args[1]).toMatch(new RegExp(`^recordings/${id}/.+\\.mp4$`));

    const dup = await w.call('POST', `/events/${id}/recordings/start`, TOKENS.organizer, {});
    expect(dup.body.error.code).toBe('RECORDING_ACTIVE');
    expect((await w.call('GET', `/events/${id}`, TOKENS.viewer)).body.recordingActive).toBe(true);

    const stop = await w.call('POST', `/events/${id}/recordings/stop`, TOKENS.organizer, {});
    expect(stop.status).toBe(200);
    expect(lk.callsTo('stopRecording')).toHaveLength(1);
    expect((await w.call('GET', `/events/${id}`, TOKENS.viewer)).body.recordingActive).toBe(false);
  });

  it('becomes playable via short-lived URLs only for members after egress completes', async () => {
    const { w, id } = await liveEvent();
    await w.call('POST', `/events/${id}/recordings/start`, TOKENS.organizer, {});
    await w.call('POST', `/events/${id}/recordings/stop`, TOKENS.organizer, {});
    const rec = [...w.store.recordings.values()][0]!;
    await handleLiveKitWebhook(w.deps, egressWebhook(rec.egressId!, 'complete'), 'mock-signature');

    const list = await w.call('GET', `/events/${id}/recordings`, TOKENS.viewer);
    expect(list.body.items[0]).toMatchObject({ status: 'READY', durationSeconds: 120, sizeBytes: 1024 });
    expect(list.body.items[0].playbackUrl).toContain('expires=900');
    expect((await w.call('GET', `/events/${id}/recordings`, TOKENS.stranger)).status).toBe(404);
  });

  it('ending the event stops an active recording', async () => {
    const { w, id, lk } = await liveEvent();
    await w.call('POST', `/events/${id}/recordings/start`, TOKENS.organizer, {});
    await w.call('POST', `/events/${id}/end`, TOKENS.organizer, {});
    expect(lk.callsTo('stopRecording')).toHaveLength(1);
  });

  it('organizers can delete recordings; the object is removed from S3', async () => {
    const { w, id } = await liveEvent();
    await w.call('POST', `/events/${id}/recordings/start`, TOKENS.organizer, {});
    await w.call('POST', `/events/${id}/recordings/stop`, TOKENS.organizer, {});
    const rec = [...w.store.recordings.values()][0]!;
    expect((await w.call('DELETE', `/events/${id}/recordings/${rec.id}`, TOKENS.viewer)).status).toBe(403);
    expect((await w.call('DELETE', `/events/${id}/recordings/${rec.id}`, TOKENS.organizer)).status).toBe(204);
    expect(w.storage.deleted).toEqual([rec.s3Key]);
    expect((await w.call('GET', `/events/${id}/recordings`, TOKENS.organizer)).body.items).toHaveLength(0);
  });

  it('marks failed egress and clears the active flag', async () => {
    const { w, id } = await liveEvent();
    await w.call('POST', `/events/${id}/recordings/start`, TOKENS.organizer, {});
    const rec = [...w.store.recordings.values()][0]!;
    await handleLiveKitWebhook(w.deps, egressWebhook(rec.egressId!, 'failed'), 'mock-signature');
    expect((await w.store.getRecording(id, rec.id))?.status).toBe('FAILED');
    expect((await w.store.getEvent(id))?.activeRecordingId).toBeNull();
  });
});
