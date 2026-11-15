import { describe, expect, it } from 'vitest';
import { addWorkingDays, isWorkingDate, nextWorkingDate } from '../src/time/working-days.ts';

const at = (iso: string) => new Date(iso);
const due = (start: string, tz?: string | null, n = 2) => addWorkingDays(at(start), n, tz).toISOString();

describe('isWorkingDate', () => {
  it('counts Monday to Friday and never the weekend', () => {
    // 2026-11-09 is a Monday
    expect(['09', '10', '11', '12', '13'].map((d) => isWorkingDate(`2026-11-${d}`))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(isWorkingDate('2026-11-14')).toBe(false);
    expect(isWorkingDate('2026-11-15')).toBe(false);
  });

  it('lets a holiday predicate remove a weekday', () => {
    expect(isWorkingDate('2026-12-25', (d) => d.endsWith('-12-25'))).toBe(false);
    expect(isWorkingDate('2026-12-24', (d) => d.endsWith('-12-25'))).toBe(true);
  });

  it('refuses something that is not a calendar date', () => {
    expect(() => isWorkingDate('12/11/2026')).toThrow();
  });
});

describe('nextWorkingDate', () => {
  it('skips the weekend', () => {
    expect(nextWorkingDate('2026-11-13')).toBe('2026-11-16');
    expect(nextWorkingDate('2026-11-14')).toBe('2026-11-16');
    expect(nextWorkingDate('2026-11-16')).toBe('2026-11-17');
  });
});

describe('addWorkingDays (2 working days, UTC unless named)', () => {
  it('Monday 09:00 is due Wednesday 09:00', () => {
    expect(due('2026-11-09T09:00:00.000Z')).toBe('2026-11-11T09:00:00.000Z');
  });

  it('Thursday 14:00 is due Monday 14:00 (over the weekend)', () => {
    expect(due('2026-11-12T14:00:00.000Z')).toBe('2026-11-16T14:00:00.000Z');
  });

  it('Friday 17:30 is due Tuesday 17:30', () => {
    expect(due('2026-11-13T17:30:00.000Z')).toBe('2026-11-17T17:30:00.000Z');
  });

  it('a Saturday or Sunday start counts from Monday 00:00 and is due Wednesday 00:00', () => {
    expect(due('2026-11-14T10:00:00.000Z')).toBe('2026-11-18T00:00:00.000Z');
    expect(due('2026-11-15T23:59:59.999Z')).toBe('2026-11-18T00:00:00.000Z');
  });

  it('keeps the seconds and milliseconds of a weekday start', () => {
    expect(due('2026-11-09T09:00:12.345Z')).toBe('2026-11-11T09:00:12.345Z');
  });

  it("counts on the owner's wall clock: Friday 23:30 in Johannesburg is due Tuesday 23:30 there", () => {
    // Friday 21:30 UTC is Friday 23:30 in Johannesburg (UTC+2, no daylight saving)
    expect(due('2026-11-13T21:30:00.000Z', 'Africa/Johannesburg')).toBe('2026-11-17T21:30:00.000Z');
    // Saturday 00:30 in Johannesburg (Friday 22:30 UTC) counts from Monday 00:00 Johannesburg time
    expect(due('2026-11-13T22:30:00.000Z', 'Africa/Johannesburg')).toBe('2026-11-17T22:00:00.000Z');
    expect(due('2026-11-13T22:30:00.000Z', 'UTC')).toBe('2026-11-17T22:30:00.000Z');
  });

  it('keeps the wall-clock time over a daylight-saving change', () => {
    // Friday 2026-10-23 10:00 BST (09:00 UTC); the clocks go back on Sunday 25 October; Tuesday 10:00 GMT is 10:00 UTC
    expect(due('2026-10-23T09:00:00.000Z', 'Europe/London')).toBe('2026-10-27T10:00:00.000Z');
  });

  it('falls back to UTC for an unknown or missing time zone', () => {
    expect(due('2026-11-13T17:30:00.000Z', 'Not/AZone')).toBe('2026-11-17T17:30:00.000Z');
    expect(due('2026-11-13T17:30:00.000Z', null)).toBe('2026-11-17T17:30:00.000Z');
    expect(due('2026-11-13T17:30:00.000Z', '')).toBe('2026-11-17T17:30:00.000Z');
  });

  it('skips a date the holiday predicate removes', () => {
    const holiday = (d: string) => d === '2026-11-16';
    expect(
      addWorkingDays(at('2026-11-13T17:30:00.000Z'), 2, 'UTC', { isHoliday: holiday }).toISOString(),
    ).toBe('2026-11-18T17:30:00.000Z');
  });

  it('accepts other counts and refuses anything below one or not whole', () => {
    expect(due('2026-11-09T09:00:00.000Z', 'UTC', 1)).toBe('2026-11-10T09:00:00.000Z');
    expect(due('2026-11-09T09:00:00.000Z', 'UTC', 5)).toBe('2026-11-16T09:00:00.000Z');
    expect(() => addWorkingDays(at('2026-11-09T09:00:00.000Z'), 0, 'UTC')).toThrow();
    expect(() => addWorkingDays(at('2026-11-09T09:00:00.000Z'), 1.5, 'UTC')).toThrow();
    expect(() => addWorkingDays(new Date(Number.NaN), 2, 'UTC')).toThrow();
  });
});
