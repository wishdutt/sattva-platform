'use client';

import { formatEventTime } from '@lsp/shared';
import { Alert, Button, Card, Skeleton } from '@lsp/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { EventStatusBadge } from '@/components/event-bits';
import { CalendarIcon, UsersIcon } from '@/components/icons';
import { InvitePanel, PeoplePanel, RecordingsPanel } from '@/components/manage-panels';
import { useAuth } from '@/lib/auth';
import { errorMessage, useAsync } from '@/lib/hooks';

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { api } = useAuth();
  const { data: event, error, loading } = useAsync(() => api.getEvent(id), [api, id]);
  const [version, setVersion] = useState(0);

  const isOrganizer = event?.myRole === 'ORGANIZER';
  const isHost = event?.myRole === 'ORGANIZER' || event?.myRole === 'BROADCASTER';
  const open = event && ['SCHEDULED', 'READY', 'LIVE'].includes(event.status);

  return (
    <AppShell>
      {loading && <Skeleton className="h-72" />}
      {error ? <Alert title="Event unavailable">{errorMessage(error)}</Alert> : null}
      {event && (
        <div className="space-y-8">
          <div className="overflow-hidden rounded-3xl bg-gradient-to-br from-brand-700 via-brand-900 to-slate-950 text-white shadow-lg">
            <div className="relative px-6 py-10 sm:px-10">
              {event.thumbnailUrl && (
                <img src={event.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25" />
              )}
              <div className="relative max-w-3xl space-y-4">
                <EventStatusBadge status={event.status} />
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{event.title}</h1>
                <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-brand-100">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarIcon size={16} />
                    {formatEventTime(event.startAt)} · {event.durationMinutes} min
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <UsersIcon size={16} />
                    Up to {event.maxParticipants} participants
                  </span>
                </div>
                {event.description && <p className="whitespace-pre-line text-brand-50/90">{event.description}</p>}
                <div className="flex flex-wrap gap-3 pt-2">
                  {open && isHost && (
                    <Link href={`/events/${event.id}/studio`}>
                      <Button variant="live" size="lg">
                        Open studio
                      </Button>
                    </Link>
                  )}
                  {open && (
                    <Link href={`/events/${event.id}/live`}>
                      <Button variant={isHost ? 'secondary' : 'live'} size="lg">
                        {event.status === 'LIVE' ? 'Join live event' : 'Go to event'}
                      </Button>
                    </Link>
                  )}
                  {isOrganizer && !['ENDED', 'CANCELLED'].includes(event.status) && (
                    <Link href={`/events/${event.id}/edit`}>
                      <Button variant="secondary" size="lg">
                        Edit
                      </Button>
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </div>

          {event.status === 'CANCELLED' && <Alert tone="warning">This event was cancelled.</Alert>}
          {event.recordingEnabled && (
            <Alert tone="info">This event may be recorded. A visible indicator is shown whenever recording is active.</Alert>
          )}

          <div className="grid gap-8 lg:grid-cols-5">
            <div className="space-y-8 lg:col-span-3">
              {isOrganizer && open && <InvitePanel event={event} onInvited={() => setVersion((v) => v + 1)} />}
              <RecordingsPanel event={event} />
              {!isOrganizer && (
                <Card className="p-6 text-sm text-slate-600">
                  {event.status === 'ENDED'
                    ? 'This event has ended. Thanks for joining!'
                    : 'You will be able to join once the host goes live. Keep this page handy.'}
                </Card>
              )}
            </div>
            <div className="lg:col-span-2">{event.canModerate && <PeoplePanel event={event} version={version} />}</div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
