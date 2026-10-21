'use client';

import { formatDuration, formatEventTime, type EventDto, type InvitationDto, type MemberDto } from '@lsp/shared';
import { Alert, Avatar, Badge, Button, Card, Field, Select, Textarea } from '@lsp/ui';
import { useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth';
import { errorMessage, useAsync } from '@/lib/hooks';
import { TrashIcon } from './icons';
import { useToast } from './toast';

export function InvitePanel({ event, onInvited }: { event: EventDto; onInvited: () => void }) {
  const { api } = useAuth();
  const toast = useToast();
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<'VIEWER' | 'BROADCASTER'>('VIEWER');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const list = emails
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = (await api.invite(event.id, { emails: list, role, message: message || undefined })) as {
        items: InvitationDto[];
        skipped?: string[];
        emailFailures?: string[];
      };
      const parts = [`${res.items.length} invitation${res.items.length === 1 ? '' : 's'} sent`];
      if (res.skipped?.length) parts.push(`${res.skipped.length} already invited`);
      toast(parts.join(' · '), 'success');
      if (res.emailFailures?.length) setError(`Email delivery failed for: ${res.emailFailures.join(', ')}`);
      setEmails('');
      setMessage('');
      onInvited();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">Invite people</h2>
      <p className="mt-1 text-sm text-slate-500">
        Each person receives a personal, single-use link. They must sign in with the invited address.
      </p>
      <form onSubmit={submit} className="mt-4 space-y-4">
        <Field label="Email addresses" htmlFor="emails" hint="Separate with commas or new lines (up to 50).">
          <Textarea id="emails" rows={3} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="ana@company.com, li@company.com" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Role" htmlFor="role">
            <Select id="role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="VIEWER">Viewer — watch, chat, raise hand</option>
              <option value="BROADCASTER">Broadcaster — publish & moderate</option>
            </Select>
          </Field>
          <Field label="Personal note (optional)" htmlFor="note">
            <Textarea id="note" rows={1} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
        </div>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" loading={busy} disabled={!emails.trim()}>
          Send invitations
        </Button>
      </form>
    </Card>
  );
}

export function PeoplePanel({ event, version }: { event: EventDto; version: number }) {
  const { api, me } = useAuth();
  const toast = useToast();
  const members = useAsync(() => api.listMembers(event.id), [api, event.id, version]);
  const isOrganizer = event.myRole === 'ORGANIZER';
  const invites = useAsync(
    () => (isOrganizer ? api.listInvitations(event.id) : Promise.resolve({ items: [] as InvitationDto[] })),
    [api, event.id, version, isOrganizer],
  );
  const pending = invites.data?.items.filter((i) => i.status === 'PENDING') ?? [];

  async function act(fn: () => Promise<unknown>, success: string) {
    try {
      await fn();
      toast(success, 'success');
      void members.reload();
      void invites.reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <Card className="divide-y divide-slate-100">
      <div className="p-6">
        <h2 className="text-base font-semibold">People</h2>
        <p className="mt-1 text-sm text-slate-500">{members.data?.items.length ?? 0} members</p>
      </div>
      <ul className="divide-y divide-slate-100">
        {members.data?.items.map((m: MemberDto) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-3 px-6 py-3">
            <Avatar name={m.displayName} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{m.displayName}</p>
              <p className="truncate text-xs text-slate-500">{m.email}</p>
            </div>
            <Badge tone={m.role === 'ORGANIZER' ? 'brand' : m.role === 'BROADCASTER' ? 'warning' : 'neutral'}>
              {m.role.toLowerCase()}
            </Badge>
            {isOrganizer && m.role !== 'ORGANIZER' && m.userId !== me?.userId && (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    act(
                      () => api.updateMember(event.id, m.userId, { role: m.role === 'VIEWER' ? 'BROADCASTER' : 'VIEWER' }),
                      'Role updated',
                    )
                  }
                >
                  {m.role === 'VIEWER' ? 'Make broadcaster' : 'Make viewer'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${m.displayName}`}
                  onClick={() => {
                    if (confirm(`Remove ${m.displayName} from this event? They will be disconnected immediately.`)) {
                      void act(() => api.removeMember(event.id, m.userId), 'Member removed');
                    }
                  }}
                >
                  <TrashIcon size={16} />
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {pending.length > 0 && (
        <div className="p-6">
          <h3 className="text-sm font-semibold text-slate-700">Pending invitations</h3>
          <ul className="mt-3 space-y-2">
            {pending.map((i) => (
              <li key={i.id} className="flex items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 truncate">{i.email}</span>
                <span className="text-xs text-slate-500">expires {formatEventTime(i.expiresAt)}</span>
                <Button size="sm" variant="ghost" onClick={() => act(() => api.revokeInvitation(event.id, i.id), 'Invitation revoked')}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function RecordingsPanel({ event }: { event: EventDto }) {
  const { api } = useAuth();
  const toast = useToast();
  const { data, reload } = useAsync(() => api.listRecordings(event.id), [api, event.id]);
  const items = data?.items ?? [];
  if (!event.recordingEnabled && items.length === 0) return null;
  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold">Recordings</h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No recordings yet.</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {items.map((r) => (
            <li key={r.id} className="space-y-2">
              <div className="flex items-center gap-3 text-sm">
                <span className="font-medium">{formatEventTime(r.startedAt)}</span>
                {r.durationSeconds != null && <span className="text-slate-500">{formatDuration(r.durationSeconds)}</span>}
                <Badge tone={r.status === 'READY' ? 'success' : r.status === 'FAILED' ? 'danger' : 'warning'}>
                  {r.status.toLowerCase()}
                </Badge>
                {event.myRole === 'ORGANIZER' && r.status !== 'ACTIVE' && r.status !== 'STARTING' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={async () => {
                      if (!confirm('Permanently delete this recording?')) return;
                      try {
                        await api.deleteRecording(event.id, r.id);
                        void reload();
                      } catch (err) {
                        toast(errorMessage(err), 'error');
                      }
                    }}
                  >
                    Delete
                  </Button>
                )}
              </div>
              {r.playbackUrl && (
                <video controls preload="metadata" className="aspect-video w-full rounded-xl bg-black" src={r.playbackUrl}>
                  <track kind="captions" />
                </video>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xs text-slate-400">Playback links are private and expire after 15 minutes.</p>
    </Card>
  );
}
