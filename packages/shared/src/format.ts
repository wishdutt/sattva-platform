/** Formats a UTC instant in the viewer's local time zone (or an explicit one). */
export function formatEventTime(iso: string, timeZone?: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso));
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

export function parseParticipantMetadata(metadata: string | undefined | null) {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { role?: string; displayName?: string; speaker?: boolean };
    if (parsed.role !== 'ORGANIZER' && parsed.role !== 'BROADCASTER' && parsed.role !== 'VIEWER') return null;
    return { role: parsed.role, displayName: parsed.displayName ?? '', speaker: !!parsed.speaker };
  } catch {
    return null;
  }
}
