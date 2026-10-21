'use client';

import { type EventDto } from '@lsp/shared';
import { Alert, Button, IconButton, LiveBadge, Select, Spinner, cx } from '@lsp/ui';
import { RoomAudioRenderer, RoomContext, useLocalParticipant } from '@livekit/components-react';
import {
  Room,
  Track,
  VideoPresets,
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from 'livekit-client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RequireAuth } from '@/components/app-shell';
import { ChatIcon, HandIcon, MicIcon, MicOffIcon, RecordIcon, ScreenIcon, UsersIcon, VideoIcon, VideoOffIcon } from '@/components/icons';
import { ChatPanel } from '@/components/live/chat-panel';
import { ConnectionPill, ElapsedTimer, NetworkQuality, ParticipantCount, RecordingIndicator } from '@/components/live/indicators';
import { ParticipantList, SpeakerQueue, useSpeakerQueue } from '@/components/live/moderation';
import { Stage } from '@/components/live/stage';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth';
import { errorMessage, useAsync } from '@/lib/hooks';
import { useChat, useLiveSession, useRoomMessages, type LiveSession } from '@/lib/live-session';

export default function StudioPage() {
  return (
    <RequireAuth>
      <Studio />
    </RequireAuth>
  );
}

interface Devices {
  cameras: MediaDeviceInfo[];
  mics: MediaDeviceInfo[];
}

function Studio() {
  const { id } = useParams<{ id: string }>();
  const { api } = useAuth();
  const { data: event, error, setData } = useAsync(() => api.getEvent(id), [api, id]);
  const session = useLiveSession(id);

  useRoomMessages(session, (msg) => {
    if (!event) return;
    if (msg.type === 'event_status') setData({ ...event, status: msg.status });
    if (msg.type === 'recording') setData({ ...event, recordingActive: msg.active });
  });

  if (error) {
    return (
      <div className="studio flex min-h-dvh items-center justify-center p-6">
        <Alert title="Studio unavailable">{errorMessage(error)}</Alert>
      </div>
    );
  }
  if (!event) {
    return (
      <div className="studio flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (event.myRole !== 'ORGANIZER' && event.myRole !== 'BROADCASTER') {
    return (
      <div className="studio flex min-h-dvh items-center justify-center p-6">
        <Alert title="Hosts only">Only organizers and broadcasters can open the studio.</Alert>
      </div>
    );
  }
  return (
    <RoomContext.Provider value={session.room}>
      <StudioRoom event={event} setEvent={setData} session={session} />
    </RoomContext.Provider>
  );
}

function StudioRoom({
  event,
  setEvent,
  session,
}: {
  event: EventDto;
  setEvent: (e: EventDto) => void;
  session: LiveSession;
}) {
  const { api } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();

  const [devices, setDevices] = useState<Devices>({ cameras: [], mics: [] });
  const [cameraId, setCameraId] = useState<string>('');
  const [micId, setMicId] = useState<string>('');
  const [videoTrack, setVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [audioTrack, setAudioTrack] = useState<LocalAudioTrack | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<'requests' | 'people' | 'chat'>('requests');
  const previewRef = useRef<HTMLVideoElement>(null);

  const connected = session.state === 'connected' || session.state === 'reconnecting';
  const queue = useSpeakerQueue(session, event.id, event.canModerate);
  const chat = useChat(session, event.id, connected);
  const pendingCount = queue.requests.filter((r) => r.status === 'PENDING').length;

  // Notify the host about new hand raises even when another tab is open.
  useRoomMessages(session, (msg) => {
    if (msg.type === 'speaker_request') {
      toast(`${msg.request.displayName} raised their hand`, 'info');
      if (panel !== 'requests') setPanel('requests');
    }
  });

  const refreshDevices = useCallback(async () => {
    const [cameras, mics] = await Promise.all([Room.getLocalDevices('videoinput'), Room.getLocalDevices('audioinput')]);
    setDevices({ cameras, mics });
  }, []);

  /** Explicit user action: asks the browser for camera/mic and starts a local-only preview. */
  async function enableDevices() {
    setBusy('devices');
    try {
      const [v, a] = await Promise.all([
        createLocalVideoTrack({ deviceId: cameraId || undefined, resolution: VideoPresets.h720.resolution }),
        createLocalAudioTrack({ deviceId: micId || undefined, echoCancellation: true, noiseSuppression: true }),
      ]);
      setVideoTrack(v);
      setAudioTrack(a);
      await refreshDevices();
      setCameraId(v.mediaStreamTrack.getSettings().deviceId ?? '');
      setMicId(a.mediaStreamTrack.getSettings().deviceId ?? '');
    } catch (err) {
      toast(`Camera/microphone unavailable: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    const el = previewRef.current;
    if (videoTrack && el) videoTrack.attach(el);
    return () => {
      if (videoTrack && el) videoTrack.detach(el);
    };
  }, [videoTrack, publishing]);

  // Stop local capture when leaving the studio.
  useEffect(
    () => () => {
      videoTrack?.stop();
      audioTrack?.stop();
    },
    [videoTrack, audioTrack],
  );

  async function switchCamera(deviceId: string) {
    setCameraId(deviceId);
    await videoTrack?.restartTrack({ deviceId, resolution: VideoPresets.h720.resolution });
  }
  async function switchMic(deviceId: string) {
    setMicId(deviceId);
    await audioTrack?.restartTrack({ deviceId, echoCancellation: true, noiseSuppression: true });
  }

  async function toggleCam() {
    if (!videoTrack) return;
    if (camOn) await videoTrack.mute();
    else await videoTrack.unmute();
    setCamOn(!camOn);
  }
  async function toggleMic() {
    if (!audioTrack) return;
    if (micOn) await audioTrack.mute();
    else await audioTrack.unmute();
    setMicOn(!micOn);
  }

  async function enterBackstage() {
    setBusy('backstage');
    try {
      if (event.status === 'SCHEDULED') setEvent(await api.startEvent(event.id, false));
      await session.connect();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function goLive() {
    if (!videoTrack || !audioTrack) return;
    setBusy('live');
    try {
      await localParticipant.publishTrack(videoTrack, { source: Track.Source.Camera, simulcast: true });
      await localParticipant.publishTrack(audioTrack, { source: Track.Source.Microphone });
      setPublishing(true);
      if (event.status !== 'LIVE') setEvent(await api.startEvent(event.id, true));
      toast('You are live', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  async function stopBroadcasting() {
    setBusy('stop');
    try {
      if (videoTrack) await localParticipant.unpublishTrack(videoTrack, false);
      if (audioTrack) await localParticipant.unpublishTrack(audioTrack, false);
      if (isScreenShareEnabled) await localParticipant.setScreenShareEnabled(false);
      setPublishing(false);
    } finally {
      setBusy(null);
    }
  }

  async function endEvent() {
    if (!confirm('End the event for everyone? All participants will be disconnected.')) return;
    setBusy('end');
    try {
      await stopBroadcasting();
      setEvent(await api.endEvent(event.id));
      await session.leave();
      router.push(`/events/${event.id}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
      setBusy(null);
    }
  }

  async function toggleScreenShare() {
    try {
      await localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: true });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  async function toggleRecording() {
    setBusy('rec');
    try {
      if (event.recordingActive) {
        await api.stopRecording(event.id);
        setEvent({ ...event, recordingActive: false });
        toast('Recording stopped', 'info');
      } else {
        if (!confirm('Start recording? Everyone in the event will see a recording indicator.')) return;
        await api.startRecording(event.id);
        setEvent({ ...event, recordingActive: true });
        toast('Recording started', 'success');
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  }

  const ended = event.status === 'ENDED' || event.status === 'CANCELLED';

  return (
    <div className="studio flex h-dvh flex-col">
      <RoomAudioRenderer />
      <header className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
        <Link href={`/events/${event.id}`} className="text-sm text-slate-400 hover:text-white">
          ← Exit
        </Link>
        <LiveBadge live={event.status === 'LIVE'} label={event.status === 'LIVE' ? 'Live' : event.status === 'READY' ? 'Backstage' : 'Offline'} />
        <h1 className="min-w-0 flex-1 truncate font-semibold">{event.title}</h1>
        <RecordingIndicator active={event.recordingActive} />
        {event.status === 'LIVE' && <ElapsedTimer since={event.liveStartedAt} />}
        {connected && (
          <>
            <ParticipantCount />
            <NetworkQuality />
          </>
        )}
        <ConnectionPill state={session.state} />
      </header>

      {ended ? (
        <div className="flex flex-1 items-center justify-center text-slate-400">This event has ended.</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <main className="flex min-h-0 flex-1 flex-col gap-3 p-3">
            <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-studio-900">
              {connected && publishing ? (
                <Stage emptyLabel="Publishing…" />
              ) : videoTrack ? (
                <>
                  <video ref={previewRef} muted playsInline className={cx('h-full w-full object-cover', !camOn && 'invisible')} />
                  <span className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-xs font-semibold uppercase tracking-wide">
                    Preview — not visible to viewers
                  </span>
                </>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
                  <VideoIcon size={40} className="text-slate-500" />
                  <p className="max-w-sm text-sm text-slate-400">
                    Turn on your camera and microphone to preview. Nothing is broadcast until you press <strong>Go live</strong>.
                  </p>
                  <Button loading={busy === 'devices'} onClick={() => void enableDevices()}>
                    Enable camera & microphone
                  </Button>
                </div>
              )}
              {session.error && (
                <div className="absolute inset-x-3 bottom-3">
                  <Alert title="Connection problem">{session.error}</Alert>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-studio-900 px-4 py-3">
              <IconButton label={micOn ? 'Mute microphone' : 'Unmute microphone'} active={micOn} disabled={!audioTrack} onClick={() => void toggleMic()}>
                {micOn ? <MicIcon /> : <MicOffIcon />}
              </IconButton>
              <IconButton label={camOn ? 'Turn camera off' : 'Turn camera on'} active={camOn} disabled={!videoTrack} onClick={() => void toggleCam()}>
                {camOn ? <VideoIcon /> : <VideoOffIcon />}
              </IconButton>
              <IconButton
                label={isScreenShareEnabled ? 'Stop sharing screen' : 'Share screen'}
                active={!isScreenShareEnabled}
                disabled={!connected || !publishing}
                onClick={() => void toggleScreenShare()}
                className={isScreenShareEnabled ? 'bg-brand-600 hover:bg-brand-500' : undefined}
              >
                <ScreenIcon />
              </IconButton>

              <div className={cx('flex min-w-0 flex-1 flex-wrap gap-2', !videoTrack && 'invisible')}>
                <label className="sr-only" htmlFor="cam">Camera</label>
                <Select id="cam" className="!h-9 max-w-52 !bg-studio-800 !text-slate-200 !ring-white/10" value={cameraId} disabled={!videoTrack} onChange={(e) => void switchCamera(e.target.value)}>
                  {devices.cameras.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || 'Camera'}
                    </option>
                  ))}
                </Select>
                <label className="sr-only" htmlFor="mic">Microphone</label>
                <Select id="mic" className="!h-9 max-w-52 !bg-studio-800 !text-slate-200 !ring-white/10" value={micId} disabled={!audioTrack} onChange={(e) => void switchMic(e.target.value)}>
                  {devices.mics.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || 'Microphone'}
                    </option>
                  ))}
                </Select>
              </div>

              {event.myRole === 'ORGANIZER' && event.recordingEnabled && event.status === 'LIVE' && (
                <Button variant="secondary" icon={<RecordIcon size={16} />} loading={busy === 'rec'} onClick={() => void toggleRecording()}>
                  {event.recordingActive ? 'Stop recording' : 'Record'}
                </Button>
              )}
              {!connected ? (
                <Button loading={busy === 'backstage' || session.state === 'connecting'} onClick={() => void enterBackstage()}>
                  Enter backstage
                </Button>
              ) : !publishing ? (
                <Button variant="live" disabled={!videoTrack || !audioTrack} loading={busy === 'live'} onClick={() => void goLive()}>
                  Go live
                </Button>
              ) : (
                <Button variant="secondary" loading={busy === 'stop'} onClick={() => void stopBroadcasting()}>
                  Stop broadcasting
                </Button>
              )}
              {connected && (
                <Button variant="danger" loading={busy === 'end'} onClick={() => void endEvent()}>
                  End event
                </Button>
              )}
            </div>
          </main>

          <aside className="flex h-96 min-h-0 flex-col border-t border-white/10 bg-studio-900 lg:h-auto lg:w-96 lg:border-l lg:border-t-0">
            <div className="flex border-b border-white/10" role="tablist">
              {(
                [
                  ['requests', 'Requests', HandIcon, pendingCount],
                  ['people', 'People', UsersIcon, 0],
                  ['chat', 'Chat', ChatIcon, 0],
                ] as const
              ).map(([key, label, Icon, count]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={panel === key}
                  onClick={() => setPanel(key)}
                  className={cx(
                    'flex flex-1 items-center justify-center gap-2 py-3 text-sm font-medium',
                    panel === key ? 'border-b-2 border-brand-500 text-white' : 'text-slate-400 hover:text-slate-200',
                  )}
                >
                  <Icon size={16} />
                  {label}
                  {count > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-xs font-bold text-black">{count}</span>}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {!connected ? (
                <p className="p-4 text-sm text-slate-500">Enter backstage to see the audience, requests and chat.</p>
              ) : panel === 'requests' ? (
                event.canModerate ? (
                  <SpeakerQueue event={event} queue={queue} />
                ) : (
                  <p className="p-4 text-sm text-slate-500">You don&apos;t have moderation rights for this event.</p>
                )
              ) : panel === 'people' ? (
                <ParticipantList event={event} />
              ) : (
                <ChatPanel dark messages={chat.messages} onSend={chat.send} onDelete={chat.remove} canModerate={event.canModerate} />
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
