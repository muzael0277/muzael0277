import { describe, it, expect } from 'vitest';
import { computeAvailability, intersectRanges, hoursForWeekday, type AvailabilityRequest } from '../availability.engine';

const TZ = 'Asia/Tashkent';

/** 2026-10-05 is a Monday. 09:00 Tashkent == 04:00 UTC. */
const MONDAY = '2026-10-05';
const MORNING_UTC = new Date('2026-10-05T03:00:00Z'); // 08:00 local, before opening

const req = (over: Partial<AvailabilityRequest> = {}): AvailabilityRequest => ({
  date: MONDAY,
  timezone: TZ,
  now: MORNING_UTC,
  serviceDurationMinutes: 60,
  serviceBufferBeforeMinutes: 0,
  serviceBufferAfterMinutes: 0,
  resourceBufferBeforeMinutes: 0,
  resourceBufferAfterMinutes: 0,
  businessHours: [{ start: '09:00', end: '18:00' }],
  branchHours: [],
  resourceSchedule: [{ weekday: 1, startTime: '09:00', endTime: '18:00' }],
  blocked: [],
  slotStepMinutes: 60,
  minLeadTimeMinutes: 0,
  maxAdvanceDays: 30,
  ...over,
});

describe('working hours', () => {
  it('produces slots only inside business hours, in the tenant timezone', () => {
    const slots = computeAvailability(req());
    expect(slots.map((s) => s.label)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']);
    // 09:00 in Tashkent is 04:00 UTC — the stored instant, not the wall clock.
    expect(slots[0]!.startsAt.toISOString()).toBe('2026-10-05T04:00:00.000Z');
  });

  it('returns nothing when the business is closed that day', () => {
    expect(computeAvailability(req({ businessHours: [] }))).toEqual([]);
  });

  it('returns nothing when the resource does not work that weekday', () => {
    expect(computeAvailability(req({
      resourceSchedule: [{ weekday: 2, startTime: '09:00', endTime: '18:00' }],
    }))).toEqual([]);
  });

  it('narrows to the branch hours when a branch opens later', () => {
    const slots = computeAvailability(req({ branchHours: [{ start: '12:00', end: '16:00' }] }));
    expect(slots.map((s) => s.label)).toEqual(['12:00', '13:00', '14:00', '15:00']);
  });

  it('narrows to the resource shift inside the business hours', () => {
    const slots = computeAvailability(req({
      resourceSchedule: [{ weekday: 1, startTime: '10:00', endTime: '14:00' }],
    }));
    expect(slots.map((s) => s.label)).toEqual(['10:00', '11:00', '12:00', '13:00']);
  });

  it('supports a split shift as two schedule rows for one weekday', () => {
    const slots = computeAvailability(req({
      resourceSchedule: [
        { weekday: 1, startTime: '09:00', endTime: '12:00' },
        { weekday: 1, startTime: '15:00', endTime: '18:00' },
      ],
    }));
    expect(slots.map((s) => s.label)).toEqual(['09:00', '10:00', '11:00', '15:00', '16:00', '17:00']);
  });

  it('never offers a slot that would run past closing time', () => {
    const slots = computeAvailability(req({ serviceDurationMinutes: 90, slotStepMinutes: 30 }));
    const last = slots.at(-1)!;
    // 16:30 + 90min = 18:00 exactly; 17:00 would overrun.
    expect(last.label).toBe('16:30');
  });
});

describe('existing bookings and buffers', () => {
  it('removes slots that collide with an existing booking', () => {
    const slots = computeAvailability(req({
      blocked: [{
        startsAt: new Date('2026-10-05T06:00:00Z'), // 11:00 local
        endsAt: new Date('2026-10-05T07:00:00Z'),   // 12:00 local
      }],
    }));
    expect(slots.map((s) => s.label)).not.toContain('11:00');
    expect(slots.map((s) => s.label)).toContain('10:00');
    expect(slots.map((s) => s.label)).toContain('12:00');
  });

  it('treats back-to-back appointments as available, not colliding', () => {
    // A booking ending exactly at 12:00 must not consume the 12:00 slot.
    const slots = computeAvailability(req({
      blocked: [{
        startsAt: new Date('2026-10-05T06:00:00Z'),
        endsAt: new Date('2026-10-05T07:00:00Z'),
      }],
    }));
    expect(slots.map((s) => s.label)).toContain('12:00');
  });

  it('blocks the slot after a booking when a cleanup buffer applies', () => {
    // 15 minutes of cleanup after the 11:00–12:00 appointment reaches into 12:00.
    const slots = computeAvailability(req({
      blocked: [{
        startsAt: new Date('2026-10-05T06:00:00Z'),
        endsAt: new Date('2026-10-05T07:15:00Z'), // already expanded by its buffer
      }],
    }));
    expect(slots.map((s) => s.label)).not.toContain('12:00');
    expect(slots.map((s) => s.label)).toContain('13:00');
  });

  it('takes the larger of the service and resource buffers rather than adding them', () => {
    // Buffers are minimums: a 20-minute service buffer and a 10-minute resource buffer
    // mean 20 minutes of cleanup, not 30.
    const withBoth = computeAvailability(req({
      serviceDurationMinutes: 60,
      serviceBufferAfterMinutes: 20,
      resourceBufferAfterMinutes: 10,
      slotStepMinutes: 30,
    }));
    const last = withBoth.at(-1)!;
    // Last start must satisfy start + 60 + 20 <= 18:00 -> 16:40, stepping by 30 -> 16:30.
    expect(last.label).toBe('16:30');
  });

  it('accounts for a buffer before the appointment as well', () => {
    const slots = computeAvailability(req({
      serviceBufferBeforeMinutes: 30,
      blocked: [{
        startsAt: new Date('2026-10-05T04:00:00Z'), // 09:00
        endsAt: new Date('2026-10-05T05:00:00Z'),   // 10:00
      }],
    }));
    // A 10:00 start needs its prep from 09:30, which overlaps the 09:00–10:00 booking.
    expect(slots.map((s) => s.label)).not.toContain('10:00');
    expect(slots.map((s) => s.label)).toContain('11:00');
  });
});

describe('lead time and horizon', () => {
  it('hides slots that are too soon to prepare for', () => {
    const slots = computeAvailability(req({
      now: new Date('2026-10-05T05:30:00Z'), // 10:30 local
      minLeadTimeMinutes: 60,                // earliest start 11:30
    }));
    expect(slots.map((s) => s.label)).not.toContain('11:00');
    expect(slots.map((s) => s.label)).toContain('12:00');
  });

  it('hides slots beyond the booking horizon', () => {
    const slots = computeAvailability(req({
      now: new Date('2026-09-01T03:00:00Z'),
      maxAdvanceDays: 7, // 2026-10-05 is far beyond that
    }));
    expect(slots).toEqual([]);
  });
});

describe('timezone correctness', () => {
  it('maps local opening time to the right UTC instant for a non-UTC tenant', () => {
    const slots = computeAvailability(req());
    for (const slot of slots) {
      const localHour = Number(slot.label.split(':')[0]);
      expect(slot.startsAt.getUTCHours()).toBe(localHour - 5); // Tashkent is UTC+5
    }
  });

  it('handles a DST tenant without shifting appointments by an hour', () => {
    // Europe/Berlin springs forward on 2026-03-29; 2026-03-30 is a Monday in CEST.
    const slots = computeAvailability(req({
      date: '2026-03-30',
      timezone: 'Europe/Berlin',
      now: new Date('2026-03-29T00:00:00Z'),
      businessHours: [{ start: '09:00', end: '12:00' }],
      resourceSchedule: [{ weekday: 1, startTime: '09:00', endTime: '12:00' }],
    }));
    expect(slots[0]!.label).toBe('09:00');
    expect(slots[0]!.startsAt.toISOString()).toBe('2026-03-30T07:00:00.000Z'); // UTC+2
  });
});

describe('intersectRanges', () => {
  it('keeps only the overlap', () => {
    expect(intersectRanges([{ start: '09:00', end: '18:00' }], [{ start: '10:00', end: '14:00' }]))
      .toEqual([{ start: '10:00', end: '14:00' }]);
  });

  it('returns nothing when ranges do not meet', () => {
    expect(intersectRanges([{ start: '09:00', end: '12:00' }], [{ start: '13:00', end: '18:00' }]))
      .toEqual([]);
  });

  it('handles multiple windows on both sides', () => {
    const result = intersectRanges(
      [{ start: '09:00', end: '13:00' }, { start: '15:00', end: '20:00' }],
      [{ start: '11:00', end: '17:00' }],
    );
    expect(result).toEqual([{ start: '11:00', end: '13:00' }, { start: '15:00', end: '17:00' }]);
  });
});

describe('hoursForWeekday', () => {
  it('reads a weekday out of the stored JSON shape', () => {
    expect(hoursForWeekday({ '1': [{ start: '10:00', end: '20:00' }] }, 1))
      .toEqual([{ start: '10:00', end: '20:00' }]);
  });

  it('treats a missing or malformed day as closed rather than throwing', () => {
    expect(hoursForWeekday({}, 3)).toEqual([]);
    expect(hoursForWeekday(null, 3)).toEqual([]);
    expect(hoursForWeekday({ '3': 'nonsense' }, 3)).toEqual([]);
    expect(hoursForWeekday({ '3': [{ bad: true }] }, 3)).toEqual([]);
  });
});
