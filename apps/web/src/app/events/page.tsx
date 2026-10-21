'use client';

import { Alert, Button, EmptyState, Skeleton } from '@lsp/ui';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { EventCard } from '@/components/event-bits';
import { PlusIcon } from '@/components/icons';
import { useAuth } from '@/lib/auth';
import { errorMessage, useAsync } from '@/lib/hooks';

export default function EventsPage() {
  return (
    <AppShell>
      <EventsList />
    </AppShell>
  );
}

function EventsList() {
  const { api, me } = useAuth();
  const { data, error, loading } = useAsync(() => api.listEvents(), [api]);
  const now = Date.now();
  const events = data?.items ?? [];
  const live = events.filter((e) => e.status === 'LIVE' || e.status === 'READY');
  const upcoming = events.filter(
    (e) => (e.status === 'SCHEDULED' || e.status === 'DRAFT') && new Date(e.startAt).getTime() + e.durationMinutes * 60_000 > now,
  );
  const past = events.filter((e) => !live.includes(e) && !upcoming.includes(e)).reverse();

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">Your events</h1>
          <p className="mt-1 text-sm text-slate-500">Events you organize or have been invited to.</p>
        </div>
        {me?.canCreateEvents && (
          <Link href="/events/new">
            <Button icon={<PlusIcon size={16} />}>New event</Button>
          </Link>
        )}
      </div>

      {error ? <Alert title="Could not load events">{errorMessage(error)}</Alert> : null}

      {loading ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          title="No events yet"
          description={
            me?.canCreateEvents
              ? 'Create your first event and invite participants by email.'
              : 'When an organizer invites you to an event, it will appear here.'
          }
          action={
            me?.canCreateEvents ? (
              <Link href="/events/new">
                <Button icon={<PlusIcon size={16} />}>Create event</Button>
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <Section title="Happening now" events={live} />
          <Section title="Upcoming" events={upcoming} />
          <Section title="Past" events={past} />
        </>
      )}
    </div>
  );
}

function Section({ title, events }: { title: string; events: Parameters<typeof EventCard>[0]['event'][] }) {
  if (events.length === 0) return null;
  return (
    <section aria-labelledby={`h-${title}`}>
      <h2 id={`h-${title}`} className="mb-4 text-sm font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </h2>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {events.map((e) => (
          <EventCard key={e.id} event={e} />
        ))}
      </div>
    </section>
  );
}
