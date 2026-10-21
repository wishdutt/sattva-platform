'use client';

import { formatEventTime, type EventStatus } from '@lsp/shared';
import { Alert, Card, Skeleton } from '@lsp/ui';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { EventStatusBadge } from '@/components/event-bits';
import { useAuth } from '@/lib/auth';
import { errorMessage, useAsync } from '@/lib/hooks';

export default function AdminPage() {
  return (
    <AppShell>
      <AdminDashboard />
    </AppShell>
  );
}

function AdminDashboard() {
  const { api, me } = useAuth();
  const { data, error, loading } = useAsync(() => api.listEvents('all'), [api]);
  if (me?.platformRole !== 'ADMIN') return <Alert title="Admins only">You do not have access to this page.</Alert>;
  const events = data?.items ?? [];
  const counts = events.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.status]: (acc[e.status] ?? 0) + 1 }), {});
  const stats: EventStatus[] = ['LIVE', 'READY', 'SCHEDULED', 'DRAFT', 'ENDED', 'CANCELLED'];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Platform overview</h1>
        <p className="mt-1 text-sm text-slate-500">
          All events across organizers. Organizer accounts are managed through the Cognito “organizers” group (see the runbook).
        </p>
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map((s) => (
          <Card key={s} className="p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{s.toLowerCase()}</p>
            <p className="mt-1 text-2xl font-bold">{counts[s] ?? 0}</p>
          </Card>
        ))}
      </div>
      {loading ? (
        <Skeleton className="h-64" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Starts</th>
                <th className="px-4 py-3">Capacity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {events.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/events/${e.id}`} className="hover:text-brand-600">
                      {e.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <EventStatusBadge status={e.status} />
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatEventTime(e.startAt)}</td>
                  <td className="px-4 py-3 text-slate-500">{e.maxParticipants}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
