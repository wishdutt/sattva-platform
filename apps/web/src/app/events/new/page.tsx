'use client';

import { useRouter } from 'next/navigation';
import { useRef } from 'react';
import { AppShell } from '@/components/app-shell';
import { EventForm } from '@/components/event-form';
import { useAuth } from '@/lib/auth';

export default function NewEventPage() {
  const { api } = useAuth();
  const router = useRouter();
  // Stable key so a double-submit or network retry never creates two events.
  const idempotencyKey = useRef(`create-${crypto.randomUUID()}`);
  return (
    <AppShell>
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 text-2xl font-bold tracking-tight">Create event</h1>
        <EventForm
          submitLabel="Create event"
          onSubmit={async (values) => {
            const event = await api.createEvent(values, idempotencyKey.current);
            router.push(`/events/${event.id}`);
          }}
        />
      </div>
    </AppShell>
  );
}
