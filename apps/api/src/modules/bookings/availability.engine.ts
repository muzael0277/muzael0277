import {
  minutesFromTimeOfDay,
  timeOfDayFromMinutes,
  zonedTimeToUtc,
  localWeekday,
  localDateString,
  rangesOverlap,
  type TimeRange,
  type Weekday,
} from '@bizbot/shared';

/**
 * Availability.
 *
 * Pure: takes schedules and existing bookings, returns slots. No database, no clock of
 * its own — `now` is passed in. That is what makes DST, lead time and buffer arithmetic
 * testable, and those are precisely the rules that quietly break appointments.
 *
 * The result is advisory. It can go stale between rendering and submitting, so the
 * booking transaction re-checks under a lock (invariant I3, see bookings.service.ts).
 */

export interface ScheduleWindow {
  weekday: Weekday;
  startTime: string;
  endTime: string;
}

export interface BlockedRange {
  startsAt: Date;
  endsAt: Date;
}

export interface AvailabilityRequest {
  /** Local calendar date in the tenant timezone, "YYYY-MM-DD". */
  date: string;
  timezone: string;
  now: Date;

  serviceDurationMinutes: number;
  serviceBufferBeforeMinutes: number;
  serviceBufferAfterMinutes: number;

  resourceBufferBeforeMinutes: number;
  resourceBufferAfterMinutes: number;

  /** Business hours for this weekday. Empty means closed. */
  businessHours: TimeRange[];
  /** Branch hours, if the branch opens later than the business. Empty means "same as business". */
  branchHours: TimeRange[];
  /** The resource's own working windows for this weekday. Empty means not working. */
  resourceSchedule: ScheduleWindow[];

  /** Time off and existing bookings, already expanded by their own buffers. */
  blocked: BlockedRange[];

  slotStepMinutes: number;
  minLeadTimeMinutes: number;
  maxAdvanceDays: number;
}

export interface AvailableSlot {
  /** UTC instant the appointment starts. The client sends this back verbatim. */
  startsAt: Date;
  endsAt: Date;
  /** Including buffers — what the booking actually occupies. */
  blockStartsAt: Date;
  blockEndsAt: Date;
  /** "14:30" in the tenant timezone, for display. */
  label: string;
}

export function computeAvailability(request: AvailabilityRequest): AvailableSlot[] {
  const weekday = localWeekday(
    zonedTimeToUtc(request.date, '12:00', request.timezone),
    request.timezone,
  );

  // 1. Business hours, then narrowed by branch hours if the branch sets its own.
  const businessWindows = request.businessHours;
  if (businessWindows.length === 0) return [];

  const branchWindows =
    request.branchHours.length > 0
      ? intersectRanges(businessWindows, request.branchHours)
      : businessWindows;
  if (branchWindows.length === 0) return [];

  // 2. Narrowed again by the resource's own shifts for this weekday. Multiple rows per
  //    weekday are how split shifts (10–14, 16–20) are expressed.
  const resourceWindows = request.resourceSchedule
    .filter((s) => s.weekday === weekday)
    .map((s) => ({ start: s.startTime, end: s.endTime }));
  if (resourceWindows.length === 0) return [];

  const workingWindows = intersectRanges(branchWindows, resourceWindows);
  if (workingWindows.length === 0) return [];

  // 3. The appointment occupies duration plus buffers. Where a service and a resource
  //    both declare a buffer, the larger wins — they are minimums, not additive.
  const bufferBefore = Math.max(
    request.serviceBufferBeforeMinutes,
    request.resourceBufferBeforeMinutes,
  );
  const bufferAfter = Math.max(
    request.serviceBufferAfterMinutes,
    request.resourceBufferAfterMinutes,
  );
  const blockMinutes = bufferBefore + request.serviceDurationMinutes + bufferAfter;

  const earliestStart = new Date(request.now.getTime() + request.minLeadTimeMinutes * 60_000);
  const latestStart = new Date(request.now.getTime() + request.maxAdvanceDays * 86_400_000);

  const slots: AvailableSlot[] = [];

  for (const window of workingWindows) {
    const windowStart = minutesFromTimeOfDay(window.start);
    const windowEnd = minutesFromTimeOfDay(window.end);

    // The grid stays anchored to the window start, so customers see clean times
    // (09:00, 10:00) rather than an offset like 09:30 introduced by a prep buffer.
    // Individual candidates are then dropped when their occupied block — buffers
    // included — would fall outside the shift. Checking only the visible duration
    // offered a 17:00 haircut whose 20-minute cleanup ran past a 18:00 shift end.
    for (let minute = windowStart; minute <= windowEnd; minute += request.slotStepMinutes) {
      if (minute - bufferBefore < windowStart) continue;
      if (minute + request.serviceDurationMinutes + bufferAfter > windowEnd) break;

      const startsAt = zonedTimeToUtc(request.date, timeOfDayFromMinutes(minute), request.timezone);
      const endsAt = new Date(startsAt.getTime() + request.serviceDurationMinutes * 60_000);
      const blockStartsAt = new Date(startsAt.getTime() - bufferBefore * 60_000);
      const blockEndsAt = new Date(endsAt.getTime() + bufferAfter * 60_000);

      // 4. Too soon to prepare for, or too far out to commit to.
      if (startsAt < earliestStart) continue;
      if (startsAt > latestStart) continue;

      // 5. The *blocked* span must be clear, not merely the visible appointment — a
      //    15-minute cleanup after the previous customer is real occupied time.
      const collides = request.blocked.some((b) =>
        rangesOverlap(blockStartsAt, blockEndsAt, b.startsAt, b.endsAt),
      );
      if (collides) continue;

      slots.push({
        startsAt,
        endsAt,
        blockStartsAt,
        blockEndsAt,
        label: timeOfDayFromMinutes(minute),
      });
    }
  }

  // Split shifts can emit overlapping candidates from adjacent windows; dedupe and sort.
  const seen = new Set<number>();
  return slots
    .filter((slot) => {
      const key = slot.startsAt.getTime();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * Intersects two sets of daily time ranges.
 * Business 09:00–22:00 ∩ resource 10:00–19:00 = 10:00–19:00.
 */
export function intersectRanges(a: TimeRange[], b: TimeRange[]): TimeRange[] {
  const result: TimeRange[] = [];
  for (const rangeA of a) {
    const startA = minutesFromTimeOfDay(rangeA.start);
    const endA = minutesFromTimeOfDay(rangeA.end);
    for (const rangeB of b) {
      const start = Math.max(startA, minutesFromTimeOfDay(rangeB.start));
      const end = Math.min(endA, minutesFromTimeOfDay(rangeB.end));
      if (start < end)
        result.push({ start: timeOfDayFromMinutes(start), end: timeOfDayFromMinutes(end) });
    }
  }
  return result.sort((x, y) => minutesFromTimeOfDay(x.start) - minutesFromTimeOfDay(y.start));
}

/** The weekday's ranges from a tenant/branch workingHours JSON blob. */
export function hoursForWeekday(workingHours: unknown, weekday: Weekday): TimeRange[] {
  if (!workingHours || typeof workingHours !== 'object') return [];
  const day = (workingHours as Record<string, unknown>)[String(weekday)];
  if (!Array.isArray(day)) return [];
  return day.filter(
    (r): r is TimeRange =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as TimeRange).start === 'string' &&
      typeof (r as TimeRange).end === 'string',
  );
}

export { localDateString };
