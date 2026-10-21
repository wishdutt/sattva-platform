'use client';

import { formatEventTime, type EventDto } from '@lsp/shared';
import { Alert, Button, IconButton, LiveBadge, Spinner, cx } from '@lsp/ui';
import {
  RoomAudioRenderer,
  RoomContext,
  StartAudio,
  useLocalParticipant,
  useLocalParticipantPermissions,
} from '@livekit/components-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RequireAuth } from '@/components/app-shell';
import { ChatIcon, ExpandIcon, HandIcon, LeaveIcon, MicIcon, MicOffIcon, VideoIcon, VideoOffIcon } from '@/components/icons';
import { ChatPanel, ReactionBar, ReactionOverlay } from '@/components/live/chat-panel';
import { ConnectionPill, NetworkQuality, ParticipantCount, RecordingIndicator } from '@/components/live/indicators';
import { Stage } from '@/components/live/stage';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth';
import { errorMessage, useAsync } from '@/lib/hooks';
import { useChat, useLiveSession, useReactions, useRoomMessages, type LiveSession } from '@/lib/live-session';

export default function LivePage() {
  return (
    <RequireAuth>
      <LiveEvent />
    </RequireAuth>
  );
}

function LiveEvent() {
  const { id } = useParams<{ id: string }>();
  const { api } = useAuth();
  const { data: event, error, reload, setData } = useAsync(() => api.getEvent(id), [api, id]);
  const session = useLiveSession(id);

  // Poll while waiting for the host to go live.
  useEffect(() => {
    if (!event || event.status === 'LIVE' || ['ENDED', 'CANCELLED'].includes(event.status)) return;
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [event, reload]);

  useRoomMessages(session, (msg) => {
    if (msg.type === 'event_status' && event) setData({ ...event, status: msg.status });
    if (msg.type === 'recording' && event) setData({ ...event, recordingActive: msg.active });
    if (msg.type === 'settings' && event) setData({ ...event, chatEnabled: msg.chatEnabled });
  });

  if (error) {
    return (
      <Shell>
        <div className="mx-auto max-w-lg p-8">
          <Alert title="You don't have access to this event">{errorMessage(error)}</Alert>
        </div>
      </Shell>
    );
  }
  if (!event) {
    return (
      <Shell>
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </Shell>
    );
  }
  if (event.status === 'ENDED' || event.status === 'CANCELLED' || session.errorCode === 'ROOM_DELETED') {
    return <EndedScreen event={event} />;
  }
  if (event.status !== 'LIVE') return <WaitingScreen event={event} />;
  if (session.state === 'idle' || (session.state === 'error' && !session.join)) {
    return <JoinScreen event={event} session={session} />;
  }
  return (
    <RoomContext.Provider value={session.room}>
      <ViewerRoom event={event} session={session} />
    </RoomContext.Provider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="studio flex min-h-dvh flex-col">{children}</div>;
}

function WaitingScreen({ event }: { event: EventDto }) {
  return (
    <Shell>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <LiveBadge live={false} label={event.status === 'READY' ? 'Starting soon' : 'Not started'} />
        <h1 className="max-w-2xl text-3xl font-bold tracking-tight">{event.title}</h1>
        <p className="text-slate-400">
          Scheduled for {formatEventTime(event.startAt)}. This page updates automatically when the host goes live.
        </p>
        <Spinner className="h-6 w-6 text-slate-500" />
        <Link href={`/events/${event.id}`} className="text-sm text-slate-400 underline">
          Back to event details
        </Link>
      </div>
    </Shell>
  );
}

function EndedScreen({ event }: { event: EventDto }) {
  return (
    <Shell>
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
        <h1 className="text-3xl font-bold">This event has ended</h1>
        <p className="max-w-md text-slate-400">
          Thanks for joining <span className="text-slate-200">{event.title}</span>.
          {event.recordingEnabled && ' If a recording was made, it will be available on the event page once processed.'}
        </p>
        <Link href={`/events/${event.id}`}>
          <Button>{event.recordingEnabled ? 'View recordings' : 'Back to event'}</Button>
        </Link>
      </div>
    </Shell>
  );
}

function JoinScreen({ event, session }: { event: EventDto; session: LiveSession }) {
  const full = session.errorCode === 'EVENT_FULL';
  return (
    <Shell>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <LiveBadge live />
        <h1 className="max-w-2xl text-3xl font-bold tracking-tight">{event.title}</h1>
        {event.recordingEnabled && (
          <p className="max-w-md text-sm text-amber-300">This event may be recorded. Your audio/video is only recorded if you are invited on stage.</p>
        )}
        {session.error && (
          <div className="w-full max-w-md text-left">
            <Alert title={full ? 'The event is full' : 'Could not join'}>{session.error}</Alert>
          </div>
        )}
        <Button size="lg" variant="live" loading={session.state === 'connecting'} onClick={() => void session.connect()}>
          {session.error ? 'Try again' : 'Join live event'}
        </Button>
        <p className="text-xs text-slate-500">You will join as a viewer. Your camera and microphone stay off.</p>
      </div>
    </Shell>
  );
}

type HandState = 'idle' | 'pending' | 'speaker';

function ViewerRoom({ event, session }: { event: EventDto; session: LiveSession }) {
  const { api } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const permissions = useLocalParticipantPermissions();
  const canPublish = !!permissions?.canPublish;
  const [hand, setHand] = useState<HandState>(session.join?.canPublish ? 'speaker' : 'idle');
  const [chatOpen, setChatOpen] = useState(true);
  const stageRef = useRef<HTMLDivElement>(null);
  const chat = useChat(session, event.id, true);
  const reactions = useReactions(session, event.id);
  const wasPublisher = useRef(canPublish);

  // Server-driven permission changes are the source of truth for stage access.
  useEffect(() => {
    if (canPublish && !wasPublisher.current) {
      setHand('speaker');
      toast("You're on stage — unmute when you're ready", 'success');
    }
    if (!canPublish && wasPublisher.current) {
      setHand('idle');
      void localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      void localParticipant.setCameraEnabled(false).catch(() => undefined);
      toast('You have left the stage', 'info');
    }
    wasPublisher.current = canPublish;
  }, [canPublish, localParticipant, toast]);

  useRoomMessages(session, (msg) => {
    if (msg.type === 'speaker_request_resolved' && msg.status === 'REJECTED') {
      setHand('idle');
      toast('The host declined your request to speak', 'info');
    }
    if (msg.type === 'speaker_revoked') setHand('idle');
  });

  const toggleHand = useCallback(async () => {
    try {
      if (hand === 'idle') {
        await api.raiseHand(event.id);
        setHand('pending');
        toast('Hand raised. The host will see your request.', 'info');
      } else {
        await api.lowerHand(event.id);
        setHand('idle');
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }, [api, event.id, hand, toast]);

  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const leave = async () => {
    await session.leave();
    router.push(`/events/${event.id}`);
  };

  const chatDisabled = !event.chatEnabled ? 'Chat is turned off' : null;

  return (
    <div className="studio flex h-dvh flex-col">
      <RoomAudioRenderer />
      <header className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-3">
        <LiveBadge live />
        <h1 className="min-w-0 flex-1 truncate font-semibold">{event.title}</h1>
        <RecordingIndicator active={event.recordingActive} />
        <ParticipantCount />
        <NetworkQuality />
        <ConnectionPill state={session.state} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div ref={stageRef} className="relative flex min-h-0 flex-1 flex-col bg-studio-950 p-3">
          <div className="min-h-0 flex-1">
            <Stage emptyLabel="Waiting for the host's video…" />
          </div>
          <ReactionOverlay items={reactions.floating} />
          <div className="absolute left-1/2 top-4 -translate-x-1/2">
            <StartAudio label="Click to enable audio" className="rounded-full bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-lg" />
          </div>
          {session.state === 'reconnecting' && (
            <div className="absolute inset-x-0 top-4 mx-auto w-fit rounded-full bg-amber-500 px-4 py-1.5 text-sm font-medium text-black">
              Reconnecting…
            </div>
          )}
        </div>

        {chatOpen && (
          <aside className="flex h-80 min-h-0 flex-col border-t border-white/10 bg-studio-900 lg:h-auto lg:w-96 lg:border-l lg:border-t-0">
            <h2 className="border-b border-white/10 px-4 py-3 text-sm font-semibold">Chat</h2>
            <ChatPanel dark messages={chat.messages} onSend={chat.send} canModerate={false} disabled={chatDisabled} />
          </aside>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-white/10 px-4 py-3">
        <ReactionBar onReact={(r) => void reactions.react(r)} />
        <div className="mx-2 h-8 w-px bg-white/10" />
        {hand === 'speaker' && canPublish ? (
          <>
            <IconButton
              label={isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
              active={isMicrophoneEnabled}
              onClick={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch((e: unknown) => toast(errorMessage(e), 'error'))}
            >
              {isMicrophoneEnabled ? <MicIcon /> : <MicOffIcon />}
            </IconButton>
            <IconButton
              label={isCameraEnabled ? 'Turn camera off' : 'Turn camera on'}
              active={isCameraEnabled}
              onClick={() => void localParticipant.setCameraEnabled(!isCameraEnabled).catch((e: unknown) => toast(errorMessage(e), 'error'))}
            >
              {isCameraEnabled ? <VideoIcon /> : <VideoOffIcon />}
            </IconButton>
            <Button variant="secondary" size="sm" onClick={() => void toggleHand()}>
              Leave stage
            </Button>
          </>
        ) : (
          event.maxSpeakers > 0 && (
            <Button
              variant={hand === 'pending' ? 'primary' : 'secondary'}
              icon={<HandIcon size={18} />}
              onClick={() => void toggleHand()}
              aria-pressed={hand === 'pending'}
            >
              {hand === 'pending' ? 'Lower hand' : 'Raise hand'}
            </Button>
          )
        )}
        <IconButton label={chatOpen ? 'Hide chat' : 'Show chat'} active onClick={() => setChatOpen((o) => !o)} className={cx(!chatOpen && 'opacity-70')}>
          <ChatIcon />
        </IconButton>
        <IconButton label="Fullscreen" active onClick={fullscreen}>
          <ExpandIcon />
        </IconButton>
        <Button variant="danger" icon={<LeaveIcon size={18} />} onClick={() => void leave()}>
          Leave
        </Button>
      </footer>
    </div>
  );
}
