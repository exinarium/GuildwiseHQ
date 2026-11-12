import { isValidTimeZone, localParts } from '../reporter/index.ts';
import { zonedWallToUtc } from '../video/schedule.ts';

/**
 * Working-day arithmetic on a person's wall clock. A working day is Monday to Friday; public holidays are not observed
 * unless the caller passes an `isHoliday` predicate. Pure: no clock read.
 */

/** ISO weekdays that are working days: 1 = Monday ... 5 = Friday. */
export const WORKING_WEEKDAYS = [1, 2, 3, 4, 5] as const;

export type HolidayPredicate = (date: string) => boolean;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(date: string): [number, number, number] {
  if (!DATE_RE.test(date)) throw new Error(`not a calendar date: ${date}`);
  return date.split('-').map(Number) as [number, number, number];
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a calendar date `YYYY-MM-DD`. */
function isoWeekday(date: string): number {
  const [y, m, d] = parseDate(date);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return js === 0 ? 7 : js;
}

function nextDate(date: string): string {
  const [y, m, d] = parseDate(date);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** Is the local calendar date (`YYYY-MM-DD`) a working day? Weekends never are; `isHoliday` can remove more days. */
export function isWorkingDate(date: string, isHoliday?: HolidayPredicate): boolean {
  if (!(WORKING_WEEKDAYS as readonly number[]).includes(isoWeekday(date))) return false;
  return !isHoliday?.(date);
}

/** The first working date after `date`. */
export function nextWorkingDate(date: string, isHoliday?: HolidayPredicate): string {
  let d = nextDate(date);
  // a year of non-working days would be a broken holiday predicate: stop rather than loop forever
  for (let i = 0; i < 366; i++) {
    if (isWorkingDate(d, isHoliday)) return d;
    d = nextDate(d);
  }
  throw new Error('no working day within a year');
}

const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * The instant `n` working days after `start` on the wall clock of `tz` (UTC when `tz` is empty or invalid).
 * Start on a working day at local time t: due at local time t (seconds and milliseconds kept) on the n-th following
 * working day. Start on a non-working day: counting starts at 00:00 of the next working day. The wall-clock time is
 * kept across daylight-saving changes.
 */
export function addWorkingDays(
  start: Date,
  n: number,
  tz: string | null | undefined,
  opts: { isHoliday?: HolidayPredicate } = {},
): Date {
  if (!Number.isInteger(n) || n < 1) throw new Error('n must be a whole number of at least 1');
  if (Number.isNaN(start.getTime())) throw new Error('start is not a valid date');
  const zone = tz && isValidTimeZone(tz) ? tz : 'UTC';
  const h = opts.isHoliday;
  let { date, minutes } = localParts(start, zone);
  let keepMs = ((start.getTime() % 60_000) + 60_000) % 60_000;
  if (!isWorkingDate(date, h)) {
    date = nextWorkingDate(date, h);
    minutes = 0;
    keepMs = 0;
  }
  for (let i = 0; i < n; i++) date = nextWorkingDate(date, h);
  return new Date(zonedWallToUtc(date, hhmm(minutes), zone).getTime() + keepMs);
}
