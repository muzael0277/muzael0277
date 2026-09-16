/**
 * Time helpers.
 *
 * Rule: every timestamp is stored and computed in UTC. A tenant timezone is applied only
 * at the presentation edge and when interpreting a tenant's working hours. Uzbekistan is
 * UTC+5 with no DST, but nothing here may assume a fixed offset — the platform is meant
 * to cross borders (see docs/architecture/09-booking-engine.md).
 */

export const DEFAULT_TIMEZONE = 'Asia/Tashkent';

/** 0 = Sunday … 6 = Saturday, matching JS getDay(). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** "HH:mm" in the tenant's local time. */
export type TimeOfDay = string;

export interface TimeRange {
  start: TimeOfDay;
  end: TimeOfDay;
}

export interface WorkingHours {
  /** Per weekday ranges. An empty array means closed that day. */
  [weekday: string]: TimeRange[];
}

export function minutesFromTimeOfDay(value: TimeOfDay): number {
  const parts = value.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1] ?? '0');
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 24 || m < 0 || m > 59) {
    throw new Error(`Invalid time of day: ${value}`);
  }
  return h * 60 + m;
}

export function timeOfDayFromMinutes(minutes: number): TimeOfDay {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Offset of a timezone at a given instant, in minutes east of UTC.
 * Computed via Intl so DST and historical changes are handled by the runtime's tz data
 * rather than by us hard-coding +5.
 */
export function timezoneOffsetMinutes(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - instant.getTime()) / 60000);
}

/** "2026-09-16" in the given timezone. */
export function localDateString(instant: Date, timeZone: string): string {
  const offset = timezoneOffsetMinutes(instant, timeZone);
  return new Date(instant.getTime() + offset * 60000).toISOString().slice(0, 10);
}

/** Weekday in the given timezone. */
export function localWeekday(instant: Date, timeZone: string): Weekday {
  const offset = timezoneOffsetMinutes(instant, timeZone);
  return new Date(instant.getTime() + offset * 60000).getUTCDay() as Weekday;
}

/**
 * Converts a local wall-clock date + time in a timezone to the UTC instant.
 *
 * Two-pass: the offset depends on the instant, and the instant depends on the offset.
 * The second pass settles DST boundaries; without it, a booking made on a transition day
 * lands an hour off.
 */
export function zonedTimeToUtc(dateISO: string, time: TimeOfDay, timeZone: string): Date {
  const [y, mo, d] = dateISO.split('-').map(Number);
  const minutes = minutesFromTimeOfDay(time);
  const naive = Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1, 0, minutes);
  const firstGuess = new Date(naive - timezoneOffsetMinutes(new Date(naive), timeZone) * 60000);
  const settled = new Date(naive - timezoneOffsetMinutes(firstGuess, timeZone) * 60000);
  return settled;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Half-open overlap: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅ */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}
