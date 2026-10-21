/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffset(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - utcMs;
}

/** Converts a `datetime-local` value interpreted in `timeZone` to a UTC ISO string. */
export function zonedInputToUtc(value: string, timeZone: string): string {
  const [date, time] = value.split('T');
  const [y, m, d] = date!.split('-').map(Number);
  const [hh, mm] = time!.split(':').map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, hh!, mm!);
  let utc = wall - tzOffset(wall, timeZone);
  utc = wall - tzOffset(utc, timeZone); // second pass handles DST boundaries
  return new Date(utc).toISOString();
}

/** Converts a UTC instant into a `datetime-local` value for `timeZone`. */
export function utcToZonedInput(iso: string, timeZone: string): string {
  const utc = new Date(iso).getTime();
  const local = new Date(utc + tzOffset(utc, timeZone));
  return local.toISOString().slice(0, 16);
}

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  return intl.supportedValuesOf?.('timeZone') ?? ['UTC', browserTimeZone()];
}
