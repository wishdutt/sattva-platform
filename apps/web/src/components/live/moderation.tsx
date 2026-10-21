'use client';

import { type EventDto, type SpeakerRequestDto } from '@lsp/shared';
import { Avatar, Badge, Button } from '@lsp/ui';
import { useParticipants } from '@livekit/components-react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { errorMessage } from '@/lib/hooks';
import { useRoomMessages, type LiveSession } from '@/lib/live-session';
import { CheckIcon, HandIcon, XIcon } from '../icons';
import { useToast } from '../toast';
import { isHostParticipant, roleOf } from './stage';

/** Live speaker request queue fed by server-pushed moderation messages. */
export function useSpeakerQueue(session: LiveSession, eventId: string, enabled: boolean) {
  const { api } = useAuth();
  const [requests, setRequests] = useState<SpeakerRequestDto[]>([]);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      setRequests((await api.listSpeakerRequests(eventId)).items);
    } catch {
      /* ignore; retried on next connect */
    }
  }, [api, eventId, enabled]);

  useEffect(() => {
    if (session.state === 'connected') void load();
  }, [session.state, load]);

  useRoomMessages(session, (msg) => {
    if (msg.type === 'speaker_request') {
      setRequests((list) => (list.some((r) => r.id === msg.request.id) ? list : [...list, msg.request]));
    }
    if (msg.type === 'speaker_request_resolved') {
      setRequests((list) =>
        list
          .map((r) => (r.id === msg.requestId ? { ...r, status: msg.status } : r))
          .filter((r) => r.status === 'PENDING' || r.status === 'APPROVED'),
      );
    }
  });

  return { requests, reload: load, setRequests };
}

export function SpeakerQueue({
  event,
  queue,
}: {
  event: EventDto;
  queue: ReturnType<typeof useSpeakerQueue>;
}) {
  const { api } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const pending = queue.requests.filter((r) => r.status === 'PENDING');
  const speakers = queue.requests.filter((r) => r.status === 'APPROVED');

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
      void queue.reload();
    }
  }

  return (
    <div className="space-y-6 p-4">
      <section>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          On stage <Badge tone="neutral">{speakers.length}/{event.maxSpeakers}</Badge>
        </h3>
        {speakers.length === 0 && <p className="text-sm text-slate-500">No audience speakers.</p>}
        <ul className="space-y-2">
          {speakers.map((r) => (
            <li key={r.id} className="flex items-center gap-3 rounded-xl bg-white/5 px-3 py-2">
              <Avatar name={r.displayName} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{r.displayName}</span>
              <Button
                size="sm"
                variant="secondary"
                loading={busy === r.id}
                onClick={() => act(r.id, () => api.demoteSpeaker(event.id, r.userId))}
              >
                Remove from stage
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          <HandIcon size={14} /> Raised hands <Badge tone={pending.length ? 'warning' : 'neutral'}>{pending.length}</Badge>
        </h3>
        {pending.length === 0 && <p className="text-sm text-slate-500">No requests right now.</p>}
        <ul className="space-y-2">
          {pending.map((r) => (
            <li key={r.id} className="flex items-center gap-3 rounded-xl bg-amber-500/10 px-3 py-2 ring-1 ring-amber-500/30">
              <Avatar name={r.displayName} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm">{r.displayName}</span>
              <button
                aria-label={`Approve ${r.displayName}`}
                disabled={busy === r.id || speakers.length >= event.maxSpeakers}
                title={speakers.length >= event.maxSpeakers ? 'Stage is full' : 'Approve'}
                onClick={() => act(r.id, () => api.approveSpeaker(event.id, r.id))}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                <CheckIcon size={16} />
              </button>
              <button
                aria-label={`Decline ${r.displayName}`}
                disabled={busy === r.id}
                onClick={() => act(r.id, () => api.rejectSpeaker(event.id, r.id))}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
              >
                <XIcon size={16} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function ParticipantList({ event }: { event: EventDto }) {
  const participants = useParticipants();
  const { api } = useAuth();
  const toast = useToast();
  const sorted = [...participants].sort((a, b) => Number(isHostParticipant(b)) - Number(isHostParticipant(a)));
  return (
    <ul className="space-y-1 p-4">
      {sorted.map((p) => (
        <li key={p.identity} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
          <Avatar name={p.name || 'Participant'} size="sm" />
          <span className="min-w-0 flex-1 truncate text-sm">
            {p.name || 'Participant'}
            {p.isLocal && <span className="text-slate-500"> (you)</span>}
          </span>
          <Badge tone={isHostParticipant(p) ? 'brand' : 'neutral'}>{roleOf(p).toLowerCase()}</Badge>
          {!p.isLocal && roleOf(p) !== 'ORGANIZER' && (
            <button
              className="text-xs text-slate-500 hover:text-red-400"
              onClick={async () => {
                if (!confirm(`Disconnect ${p.name}? They can rejoin unless removed from the event.`)) return;
                try {
                  await api.removeFromRoom(event.id, p.identity);
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              }}
            >
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
