'use client';

import { parseParticipantMetadata } from '@lsp/shared';
import { Avatar, cx } from '@lsp/ui';
import {
  VideoTrack,
  isTrackReference,
  useIsSpeaking,
  useTracks,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { Track, type Participant } from 'livekit-client';
import { MicOffIcon } from '../icons';

export const roleOf = (p: Participant) => parseParticipantMetadata(p.metadata)?.role ?? 'VIEWER';
export const isHostParticipant = (p: Participant) => {
  const r = roleOf(p);
  return r === 'ORGANIZER' || r === 'BROADCASTER';
};
export const isOnStage = (p: Participant) => isHostParticipant(p) || !!parseParticipantMetadata(p.metadata)?.speaker;

function Tile({ trackRef, large, contain }: { trackRef: TrackReferenceOrPlaceholder; large?: boolean; contain?: boolean }) {
  const p = trackRef.participant;
  const speaking = useIsSpeaking(p);
  const hasVideo = isTrackReference(trackRef) && !trackRef.publication.isMuted;
  const name = p.name || parseParticipantMetadata(p.metadata)?.displayName || 'Participant';
  return (
    <div
      className={cx(
        'relative overflow-hidden rounded-2xl bg-studio-800 ring-2 transition',
        speaking ? 'ring-emerald-400' : 'ring-transparent',
        large ? 'h-full w-full' : 'aspect-video',
      )}
    >
      {hasVideo ? (
        <VideoTrack trackRef={trackRef} className={contain ? 'lk-video-contain' : 'lk-video-fit'} />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Avatar name={name} size={large ? 'xl' : 'lg'} />
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs font-medium text-white">
        {!p.isMicrophoneEnabled && <MicOffIcon size={12} className="text-red-400" />}
        <span className="max-w-40 truncate">
          {name}
          {p.isLocal ? ' (you)' : ''}
        </span>
        {trackRef.source === Track.Source.ScreenShare && <span className="text-slate-300">· screen</span>}
      </div>
    </div>
  );
}

/**
 * Stage layout: a screen share (if any) or the primary broadcaster is shown large;
 * other hosts and approved speakers appear in a filmstrip.
 */
export function Stage({ emptyLabel }: { emptyLabel: string }) {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const onStage = tracks.filter((t) => isOnStage(t.participant));
  const screen = onStage.find((t) => t.source === Track.Source.ScreenShare && isTrackReference(t));
  const cameras = onStage.filter((t) => t.source === Track.Source.Camera);
  const hostCam = cameras.find((t) => isHostParticipant(t.participant) && isTrackReference(t)) ?? cameras.find((t) => isHostParticipant(t.participant));
  const main = screen ?? hostCam;
  const strip = cameras.filter((t) => t !== main);

  if (!main) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-2xl bg-studio-900 text-center text-slate-400">
        <div className="h-3 w-3 animate-pulse rounded-full bg-slate-500" />
        <p className="text-sm">{emptyLabel}</p>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full flex-col gap-3">
      <div className="min-h-0 flex-1">
        <Tile trackRef={main} large contain={main.source === Track.Source.ScreenShare} />
      </div>
      {strip.length > 0 && (
        <div className="grid shrink-0 grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {strip.map((t) => (
            <Tile key={`${t.participant.identity}-${t.source}`} trackRef={t} />
          ))}
        </div>
      )}
    </div>
  );
}
