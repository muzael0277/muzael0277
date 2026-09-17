import { describe, it, expect } from 'vitest';
import {
  zonedTimeToUtc,
  localDateString,
  localWeekday,
  minutesFromTimeOfDay,
  timeOfDayFromMinutes,
  rangesOverlap,
  timezoneOffsetMinutes,
} from '../time';

describe('timezone handling', () => {
  it('resolves Asia/Tashkent as UTC+5', () => {
    expect(timezoneOffsetMinutes(new Date('2026-09-16T12:00:00Z'), 'Asia/Tashkent')).toBe(300);
  });

  it('converts a local wall clock to the right UTC instant', () => {
    // 10:00 in Tashkent is 05:00 UTC
    expect(zonedTimeToUtc('2026-09-16', '10:00', 'Asia/Tashkent').toISOString()).toBe(
      '2026-09-16T05:00:00.000Z',
    );
  });

  it('settles DST boundaries in zones that observe it', () => {
    // Europe/Berlin: 2026-03-29 is the spring-forward day (CET -> CEST).
    const before = zonedTimeToUtc('2026-03-29', '01:00', 'Europe/Berlin');
    const after = zonedTimeToUtc('2026-03-29', '12:00', 'Europe/Berlin');
    expect(before.toISOString()).toBe('2026-03-29T00:00:00.000Z'); // UTC+1
    expect(after.toISOString()).toBe('2026-03-29T10:00:00.000Z'); // UTC+2
  });

  it('derives the local calendar date across the UTC day boundary', () => {
    // 22:00 UTC is already the next day in Tashkent.
    expect(localDateString(new Date('2026-09-16T22:00:00Z'), 'Asia/Tashkent')).toBe('2026-09-17');
    expect(localWeekday(new Date('2026-09-16T22:00:00Z'), 'Asia/Tashkent')).toBe(4); // Thursday
  });
});

describe('time of day', () => {
  it('round-trips through minutes', () => {
    expect(minutesFromTimeOfDay('09:30')).toBe(570);
    expect(timeOfDayFromMinutes(570)).toBe('09:30');
    expect(timeOfDayFromMinutes(0)).toBe('00:00');
  });

  it('rejects malformed values rather than guessing', () => {
    expect(() => minutesFromTimeOfDay('9:aa')).toThrow();
    expect(() => minutesFromTimeOfDay('25:00')).toThrow();
  });
});

describe('rangesOverlap', () => {
  const d = (s: string) => new Date(`2026-09-16T${s}:00Z`);

  it('treats ranges as half-open so back-to-back slots do not collide', () => {
    expect(rangesOverlap(d('10:00'), d('11:00'), d('11:00'), d('12:00'))).toBe(false);
  });

  it('detects partial and full overlap', () => {
    expect(rangesOverlap(d('10:00'), d('11:00'), d('10:30'), d('11:30'))).toBe(true);
    expect(rangesOverlap(d('10:00'), d('12:00'), d('10:30'), d('11:00'))).toBe(true);
  });
});
