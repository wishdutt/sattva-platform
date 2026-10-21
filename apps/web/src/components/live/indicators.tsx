'use client';

import { formatDuration } from '@lsp/shared';
import { cx } from '@lsp/ui';
import { useConnectionQualityIndicator, useParticipants } from '@livekit/components-react';
import { ConnectionQuality } from 'livekit-client';
import { useNow } from '@/lib/hooks';
import type { SessionState } from '@/lib/live-session';
import { RecordIcon, UsersIcon } from '../icons';

export function ConnectionPill({ state }: { state: SessionState }) {
  const map: Record<SessionState, [string, string]> = {
    idle: ['Not connected', 'bg-slate-500'],
    connecting: ['Connecting…', 'bg-amber-400 animate-pulse'],
    connected: ['Connected', 'bg-emerald-400'],
    reconnecting: ['Reconnecting…', 'bg-amber-400 animate-pulse'],
    disconnected: ['Disconnected', 'bg-slate-500'],
    error: ['Connection error', 'bg-red-500'],
  };
  const [label, dot] = map[state];
  return (
    <span className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3 py-1 text-xs font-medium text-slate-300 ring-1 ring-white/10" role="status">
      <span className={cx('h-2 w-2 rounded-full', dot)} />
      {label}
    </span>
  );
}

export function NetworkQuality() {
  const { quality } = useConnectionQualityIndicator();
  const bars = quality === ConnectionQuality.Excellent ? 4 : quality === ConnectionQuality.Good ? 3 : quality === ConnectionQuality.Poor ? 1 : 0;
  // ConnectionQuality is a string enum ('excellent' | 'good' | 'poor' | 'lost' | 'unknown').
  const label: string = quality;
  return (
    <span className="inline-flex items-end gap-0.5" title={`Network: ${label}`} aria-label={`Network quality ${label}`}>
      {[1, 2, 3, 4].map((b) => (
        <span
          key={b}
          className={cx('w-1 rounded-sm', b <= bars ? (bars <= 1 ? 'bg-red-400' : 'bg-emerald-400') : 'bg-white/20')}
          style={{ height: 4 + b * 3 }}
        />
      ))}
    </span>
  );
}

export function ParticipantCount() {
  const participants = useParticipants();
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-300" aria-label={`${participants.length} participants`}>
      <UsersIcon size={16} />
      {participants.length}
    </span>
  );
}

export function ElapsedTimer({ since }: { since: string | null }) {
  const now = useNow();
  if (!since) return <span className="font-mono text-sm text-slate-400">00:00</span>;
  return <span className="font-mono text-sm tabular-nums text-slate-200">{formatDuration((now - new Date(since).getTime()) / 1000)}</span>;
}

export function RecordingIndicator({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-600/20 px-3 py-1 text-xs font-semibold text-red-300 ring-1 ring-red-500/40" role="status">
      <RecordIcon size={14} className="animate-pulse" />
      Recording
    </span>
  );
}
