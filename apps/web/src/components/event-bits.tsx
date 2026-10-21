'use client';

import { formatEventTime, type EventDto, type EventStatus } from '@lsp/shared';
import { Badge, LiveBadge } from '@lsp/ui';
import Link from 'next/link';
import { CalendarIcon } from './icons';

const tone: Record<EventStatus, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> = {
  DRAFT: 'neutral',
  SCHEDULED: 'brand',
  READY: 'warning',
  LIVE: 'danger',
  ENDED: 'neutral',
  CANCELLED: 'neutral',
};

export function EventStatusBadge({ status }: { status: EventStatus }) {
  if (status === 'LIVE') return <LiveBadge live />;
  const label = status === 'READY' ? 'Backstage' : status.charAt(0) + status.slice(1).toLowerCase();
  return <Badge tone={tone[status]}>{label}</Badge>;
}

export function EventCard({ event }: { event: EventDto }) {
  return (
    <Link
      href={`/events/${event.id}`}
      className="group flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 transition hover:shadow-md hover:ring-slate-300"
    >
      <div className="relative aspect-video bg-gradient-to-br from-brand-600 via-brand-800 to-slate-900">
        {event.thumbnailUrl && (
          <img src={event.thumbnailUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        )}
        <div className="absolute left-3 top-3">
          <EventStatusBadge status={event.status} />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-2 font-semibold text-slate-900 group-hover:text-brand-700">{event.title}</h3>
        <p className="flex items-center gap-1.5 text-sm text-slate-500">
          <CalendarIcon size={14} />
          <time dateTime={event.startAt}>{formatEventTime(event.startAt)}</time>
        </p>
        <div className="mt-auto flex items-center gap-2 pt-2">
          {event.myRole && <Badge>{event.myRole.toLowerCase()}</Badge>}
          {event.recordingEnabled && <Badge tone="warning">Recorded</Badge>}
        </div>
      </div>
    </Link>
  );
}
