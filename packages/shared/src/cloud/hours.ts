import { z } from 'zod';

/** Office hours: the cloud workstation only wakes inside these hours (days 0 = Sunday ... 6 = Saturday). */
export const OfficeHoursSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  /** `HH:MM`, 24-hour, in `timezone`. */
  from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** IANA name, e.g. `Africa/Johannesburg`. */
  timezone: z.string().min(1).max(64),
});
export type OfficeHours = z.infer<typeof OfficeHoursSchema>;

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const toMin = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));

/** Is `at` inside the office hours? (A window that ends before it starts runs past midnight.) No hours: always. */
export function inOfficeHours(h: OfficeHours | null | undefined, at: Date): boolean {
  if (!h) return true;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: h.timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return true;
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = WEEKDAY[get('weekday')] ?? 0;
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  const from = toMin(h.from);
  const to = toMin(h.to);
  if (from <= to) return h.days.includes(day) && mins >= from && mins < to;
  // Past midnight: the early part belongs to the day the window started on.
  if (mins >= from) return h.days.includes(day);
  return mins < to && h.days.includes((day + 6) % 7);
}

/** Hours a month the window covers (52 weeks / 12), for the cost estimate. Without hours: a working month. */
export function officeHoursPerMonth(h: OfficeHours | null | undefined): number {
  if (!h) return 8 * 22;
  let span = toMin(h.to) - toMin(h.from);
  if (span <= 0) span += 24 * 60;
  return Math.round(((span / 60) * h.days.length * 52) / 12);
}
