'use client';

import { LIMITS, type CreateEventInput, type EventDto } from '@lsp/shared';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@lsp/ui';
import { useMemo, useState, type FormEvent } from 'react';
import { browserTimeZone, timeZones, utcToZonedInput, zonedInputToUtc } from '@/lib/time';

export interface EventFormValues extends Omit<CreateEventInput, 'publish'> {
  publish?: boolean;
}

function Toggle({ id, label, description, checked, onChange }: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 ring-slate-200 hover:bg-slate-50">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-600"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-sm font-medium text-slate-900">{label}</span>
        <span className="block text-xs text-slate-500">{description}</span>
      </span>
    </label>
  );
}

export function EventForm({
  initial,
  submitLabel,
  onSubmit,
  lockSchedule,
}: {
  initial?: EventDto;
  submitLabel: string;
  onSubmit: (values: EventFormValues) => Promise<void>;
  lockSchedule?: boolean;
}) {
  const zones = useMemo(() => timeZones(), []);
  const [timeZone, setTimeZone] = useState(initial?.timeZone ?? browserTimeZone());
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [start, setStart] = useState(() =>
    initial
      ? utcToZonedInput(initial.startAt, initial.timeZone)
      : utcToZonedInput(new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 86_400_000).toISOString(), browserTimeZone()),
  );
  const [duration, setDuration] = useState(initial?.durationMinutes ?? 60);
  const [maxParticipants, setMaxParticipants] = useState(initial?.maxParticipants ?? LIMITS.maxParticipants);
  const [maxSpeakers, setMaxSpeakers] = useState(initial?.maxSpeakers ?? LIMITS.maxSpeakers);
  const [recordingEnabled, setRecordingEnabled] = useState(initial?.recordingEnabled ?? false);
  const [chatEnabled, setChatEnabled] = useState(initial?.chatEnabled ?? true);
  const [chatPersistence, setChatPersistence] = useState(initial?.chatPersistence ?? true);
  const [publish, setPublish] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onSubmit({
        title,
        description,
        startAt: zonedInputToUtc(start, timeZone),
        durationMinutes: Number(duration),
        timeZone,
        maxParticipants: Number(maxParticipants),
        maxSpeakers: Number(maxSpeakers),
        recordingEnabled,
        chatEnabled,
        chatPersistence,
        publish,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handle} className="space-y-6">
      <Card className="space-y-5 p-6">
        <h2 className="text-base font-semibold">Details</h2>
        <Field label="Title" htmlFor="title">
          <Input id="title" required maxLength={LIMITS.titleMaxLength} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Description" htmlFor="description" hint="Shown to invited participants.">
          <Textarea
            id="description"
            rows={4}
            maxLength={LIMITS.descriptionMaxLength}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </Card>

      <Card className="space-y-5 p-6">
        <h2 className="text-base font-semibold">Schedule</h2>
        {lockSchedule && <Alert tone="info">Schedule and capacity cannot change while the event is live.</Alert>}
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Start" htmlFor="start">
            <Input id="start" type="datetime-local" required disabled={lockSchedule} value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Time zone" htmlFor="tz">
            <Select id="tz" disabled={lockSchedule} value={timeZone} onChange={(e) => setTimeZone(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Duration (minutes)" htmlFor="duration">
            <Input
              id="duration"
              type="number"
              min={15}
              max={720}
              step={15}
              required
              disabled={lockSchedule}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
          </Field>
        </div>
      </Card>

      <Card className="space-y-5 p-6">
        <h2 className="text-base font-semibold">Audience & features</h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Participant limit" htmlFor="maxp" hint={`Including hosts. Maximum ${LIMITS.maxParticipants}.`}>
            <Input
              id="maxp"
              type="number"
              min={2}
              max={LIMITS.maxParticipants}
              disabled={lockSchedule}
              value={maxParticipants}
              onChange={(e) => setMaxParticipants(Number(e.target.value))}
            />
          </Field>
          <Field label="Audience speakers on stage" htmlFor="maxs" hint={`0 disables raise-hand. Maximum ${LIMITS.maxSpeakers}.`}>
            <Input
              id="maxs"
              type="number"
              min={0}
              max={LIMITS.maxSpeakers}
              disabled={lockSchedule}
              value={maxSpeakers}
              onChange={(e) => setMaxSpeakers(Number(e.target.value))}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle
            id="rec"
            label="Allow recording"
            description="Organizers can record to private storage. Participants see a recording notice."
            checked={recordingEnabled}
            onChange={setRecordingEnabled}
          />
          <Toggle id="chat" label="Live chat" description="Participants can send chat messages." checked={chatEnabled} onChange={setChatEnabled} />
          <Toggle
            id="chatp"
            label="Save chat history"
            description="Store messages so late joiners and organizers can read them."
            checked={chatPersistence}
            onChange={setChatPersistence}
          />
          {!initial && (
            <Toggle
              id="publish"
              label="Publish immediately"
              description="Unpublished drafts are hidden from invitees."
              checked={publish}
              onChange={setPublish}
            />
          )}
        </div>
      </Card>

      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" size="lg" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
