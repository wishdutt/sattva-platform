'use client';

import { Alert, Button, Card, Skeleton } from '@lsp/ui';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { EventForm } from '@/components/event-form';
import { useToast } from '@/components/toast';
import { useAuth } from '@/lib/auth';
import { errorMessage, useAsync } from '@/lib/hooks';

export default function EditEventPage() {
  const { id } = useParams<{ id: string }>();
  const { api } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const { data: event, error, loading } = useAsync(() => api.getEvent(id), [api, id]);
  const [uploading, setUploading] = useState(false);

  async function uploadThumbnail(file: File) {
    setUploading(true);
    try {
      const { uploadUrl, key } = await api.thumbnailUploadUrl(id, file.type, file.size);
      const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!res.ok) throw new Error('Upload failed');
      await api.updateEvent(id, { thumbnailKey: key });
      toast('Thumbnail updated', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setUploading(false);
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">Edit event</h1>
        {loading && <Skeleton className="h-96" />}
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {event && (
          <>
            <Card className="flex flex-wrap items-center justify-between gap-4 p-6">
              <div>
                <h2 className="text-base font-semibold">Thumbnail</h2>
                <p className="text-sm text-slate-500">JPEG, PNG or WebP up to 5 MB.</p>
              </div>
              <label className="inline-flex">
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  onChange={(e) => e.target.files?.[0] && void uploadThumbnail(e.target.files[0])}
                />
                <span className="inline-flex h-10 cursor-pointer items-center rounded-lg bg-white px-4 text-sm font-semibold ring-1 ring-slate-300 hover:bg-slate-50">
                  {uploading ? 'Uploading…' : 'Upload image'}
                </span>
              </label>
            </Card>
            <EventForm
              initial={event}
              lockSchedule={event.status === 'LIVE'}
              submitLabel="Save changes"
              onSubmit={async ({ publish: _publish, ...values }) => {
                const changes = event.status === 'LIVE'
                  ? {
                      title: values.title,
                      description: values.description,
                      recordingEnabled: values.recordingEnabled,
                      chatEnabled: values.chatEnabled,
                      chatPersistence: values.chatPersistence,
                    }
                  : values;
                await api.updateEvent(id, changes);
                toast('Event saved', 'success');
                router.push(`/events/${id}`);
              }}
            />
            {['DRAFT', 'SCHEDULED', 'READY'].includes(event.status) && (
              <Card className="flex flex-wrap items-center justify-between gap-4 p-6 ring-red-200">
                <div>
                  <h2 className="text-base font-semibold text-red-700">Cancel event</h2>
                  <p className="text-sm text-slate-500">Invitees will no longer be able to join.</p>
                </div>
                <Button
                  variant="danger"
                  onClick={async () => {
                    if (!confirm('Cancel this event? This cannot be undone.')) return;
                    await api.updateEvent(id, { status: 'CANCELLED' });
                    router.push(`/events/${id}`);
                  }}
                >
                  Cancel event
                </Button>
              </Card>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
