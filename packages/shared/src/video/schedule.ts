import { z } from 'zod';
import { SOCIAL_LIMITS } from '../blog/constants.ts';
import { isValidTimeZone } from '../reporter/index.ts';

/**
 * The publishing schedule of the video push: which weekdays and at what local time a format goes out, to which
 * destinations, plus the pure slot arithmetic (DST-correct, no dependency). Slots are stored in UTC; the owner's wall
 * clock only decides WHICH instants are slots. Docs: docs/BLOG-API.md "YouTube".
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * Where a video can be posted. YouTube is the only destination that posts in this version; the others are accepted in
 * the schedule and get a share row that stays `skipped` ("not available yet") until their adapters ship.
 * Instagram and TikTok are deliberately NOT in `SOCIAL_NETWORKS` (the blog sweep shares to that list).
 */
export const VIDEO_DESTINATIONS = [
  'youtube',
  'facebook',
  'instagram',
  'x',
  'linkedin',
  'bluesky',
  'tiktok',
] as const;
export type VideoDestination = (typeof VIDEO_DESTINATIONS)[number];

export const SCHEDULE_DEFAULTS = {
  timezone: 'Africa/Johannesburg',
  longDayOrder: ['mon', 'wed', 'fri', 'tue', 'thu', 'sat', 'sun'] as Weekday[],
  shortDayOrder: ['tue', 'thu', 'sat', 'mon', 'wed', 'fri', 'sun'] as Weekday[],
  longTime: '10:00',
  shortTime: '16:00',
  longLeadHours: 48,
  shortLeadHours: 24,
  /** The earliest a post may be scheduled after "now": time for the render and YouTube's future-publishAt rule. */
  minLeadMs: { long: 3 * 3_600_000, short: 3_600_000, preview: 30 * 60_000 },
  /** At this long before the slot a post that is still not rendered slips to the next free slot. */
  slipBeforeMs: 30 * 60_000,
  /** The writer stops when the backlog (in review + scheduled, not published) reaches this many weeks of slots. */
  backlogFactor: 2,
} as const;

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time as HH:MM');
const Days = z
  .array(z.enum(WEEKDAYS))
  .max(7)
  .refine((d) => new Set(d).size === d.length, 'each weekday once');

const FormatScheduleBase = z.object({
  /** Weekdays (in the schedule's time zone) a video of this format goes out. Empty: none, the writer drafts none. */
  days: Days,
  /** Local time of day, `HH:MM`. */
  time: Time,
  destinations: z.array(z.enum(VIDEO_DESTINATIONS)).min(1),
  /** How long before its slot the render starts. */
  renderLeadHours: z.number().int().min(1).max(168),
});
export const FormatScheduleSchema = FormatScheduleBase;
export type FormatSchedule = z.infer<typeof FormatScheduleSchema>;
/** Long videos go to YouTube only (version 1). */
export const LongScheduleSchema = FormatScheduleBase.refine(
  (f) => f.destinations.length === 1 && f.destinations[0] === 'youtube',
  { message: 'long videos go to YouTube only', path: ['destinations'] },
);

export const VideoScheduleSchema = z.object({
  timezone: z.string().refine(isValidTimeZone, 'an IANA time zone such as Africa/Johannesburg'),
  long: LongScheduleSchema,
  short: FormatScheduleSchema,
});
export type VideoSchedule = z.infer<typeof VideoScheduleSchema>;

/** A patch of the schedule: any part of it. */
export const PatchVideoScheduleSchema = z.object({
  timezone: VideoScheduleSchema.shape.timezone.optional(),
  long: FormatScheduleBase.partial().optional(),
  short: FormatScheduleBase.partial().optional(),
});
export type PatchVideoSchedule = z.infer<typeof PatchVideoScheduleSchema>;

/** The schedule derived from the old weekly counts: the first `perWeek` days of the default order. */
export function defaultSchedule(perWeek = 3, shortsPerWeek = 3): VideoSchedule {
  const n = (v: number) => Math.max(0, Math.min(7, Math.floor(v)));
  return {
    timezone: SCHEDULE_DEFAULTS.timezone,
    long: {
      days: SCHEDULE_DEFAULTS.longDayOrder.slice(0, n(perWeek)),
      time: SCHEDULE_DEFAULTS.longTime,
      destinations: ['youtube'],
      renderLeadHours: SCHEDULE_DEFAULTS.longLeadHours,
    },
    short: {
      days: SCHEDULE_DEFAULTS.shortDayOrder.slice(0, n(shortsPerWeek)),
      time: SCHEDULE_DEFAULTS.shortTime,
      destinations: ['youtube'],
      renderLeadHours: SCHEDULE_DEFAULTS.shortLeadHours,
    },
  };
}

/** The schedule in force: the saved one, or the one derived from the old weekly counts while none was saved. */
export function resolveSchedule(v: {
  schedule?: unknown;
  perWeek?: number;
  shortsPerWeek?: number;
}): VideoSchedule {
  const saved = VideoScheduleSchema.safeParse(v.schedule);
  return saved.success ? saved.data : defaultSchedule(v.perWeek ?? 3, v.shortsPerWeek ?? 3);
}

/** `days` in week order (Monday first), whatever order they were ticked in. */
export const sortDays = (d: readonly Weekday[]): Weekday[] =>
  [...d].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));

// ---- time zone arithmetic (Intl only)

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}
function wallOf(ms: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const x of dtf(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return {
    y: p.year as number,
    mo: p.month as number,
    d: p.day as number,
    h: p.hour as number,
    mi: p.minute as number,
    s: p.second as number,
  };
}

/** Offset of `tz` from UTC at an instant, in ms (positive east of Greenwich). */
export function tzOffsetMs(ms: number, tz: string): number {
  const w = wallOf(Math.floor(ms / 1000) * 1000, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** `YYYY-MM-DD` of an instant on the wall clock of `tz`. */
export function localDate(ms: number, tz: string): string {
  const w = wallOf(ms, tz);
  return `${String(w.y).padStart(4, '0')}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

const addDays = (date: string, n: number): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const weekdayOf = (date: string): Weekday => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7] as Weekday;
};

/**
 * The UTC instant at which the wall clock of `tz` shows `date` `time`. A wall time that does not exist (the clock
 * jumped forward over it) moves forward by the jump; one that happens twice (the clock went back) takes the first.
 */
export function zonedWallToUtc(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const before = tzOffsetMs(guess - 86_400_000, tz);
  const after = tzOffsetMs(guess + 86_400_000, tz);
  const valid = [...new Set([before, after])]
    .map((o) => ({ o, utc: guess - o }))
    .filter((c) => tzOffsetMs(c.utc, tz) === c.o)
    .map((c) => c.utc)
    .sort((a, b) => a - b);
  if (valid.length) return new Date(valid[0] as number);
  return new Date(guess - before); // in the gap: the pre-jump offset lands after it
}

/** Is `at` exactly one of the slots of `fs` in `tz`? */
export function isScheduleSlot(fs: FormatSchedule, tz: string, at: Date): boolean {
  if (Number.isNaN(at.getTime())) return false;
  const date = localDate(at.getTime(), tz);
  return fs.days.includes(weekdayOf(date)) && zonedWallToUtc(date, fs.time, tz).getTime() === at.getTime();
}

/** Lazily walks the slots at or after `from`, up to 400 local days. */
function* walkSlots(fs: FormatSchedule, tz: string, from: Date): Generator<Date> {
  if (!fs.days.length) return;
  const start = addDays(localDate(from.getTime(), tz), -1);
  for (let i = 0; i < 402; i++) {
    const date = addDays(start, i);
    if (!fs.days.includes(weekdayOf(date))) continue;
    const slot = zonedWallToUtc(date, fs.time, tz);
    if (slot.getTime() >= from.getTime()) yield slot;
  }
}

/** The next `n` slots at or after `from` (fewer when `days` is empty). */
export function slotsFrom(fs: FormatSchedule, tz: string, from: Date, n: number): Date[] {
  const out: Date[] = [];
  if (n <= 0) return out;
  for (const s of walkSlots(fs, tz, from)) {
    out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * The first slot at or after `now + minLeadMs` that nobody holds (`taken` holds epoch milliseconds), or null when the
 * schedule has no days. A pairing (a Short after its long video) passes the later of the two instants as `now`.
 */
export function nextFreeSlot(
  fs: FormatSchedule,
  tz: string,
  now: Date,
  taken: ReadonlySet<number>,
  minLeadMs: number,
): Date | null {
  const from = new Date(now.getTime() + minLeadMs);
  for (const s of walkSlots(fs, tz, from)) if (!taken.has(s.getTime())) return s;
  return null;
}

// ---- capacity

/** Writer limit per rolling week = the number of days ticked. */
export const weeklyLimit = (fs: FormatSchedule): number => fs.days.length;
/** The writer stops while the backlog (in review + scheduled, not published) is at or over this. */
export const backlogLimit = (fs: FormatSchedule): number => SCHEDULE_DEFAULTS.backlogFactor * fs.days.length;

// ---- captions per destination

/**
 * Caption limits per destination: the social networks' limits plus Instagram and TikTok (2,200 characters, 3-5 hashtags)
 * and YouTube (a 100-character title; the description is built from the script).
 */
export const VIDEO_CAPTION_LIMITS = {
  ...SOCIAL_LIMITS,
  instagram: { total: 2200, tags: [3, 5] },
  tiktok: { total: 2200, tags: [3, 5] },
  youtube: { title: 100, tags: [0, 15] },
} as const satisfies Record<
  VideoDestination,
  { text?: number; total?: number; title?: number; tags: readonly [number, number] }
>;

/** What the owner edits per destination at schedule time: the caption text and its hashtags (no `#`). */
export const VideoCaptionsSchema = z.partialRecord(
  z.enum(VIDEO_DESTINATIONS),
  z.object({ text: z.string().max(5000), tags: z.array(z.string().max(60)).max(15).default([]) }),
);
export type VideoCaptions = z.infer<typeof VideoCaptionsSchema>;

/**
 * The caption a destination starts from when nobody wrote one: the title (X and Bluesky) or the title and description, and
 * the hashtags (no `#`, at most the destination's maximum). Never a link.
 */
export function defaultVideoCaption(
  dest: VideoDestination,
  meta: { title: string; description: string; hashtags: readonly string[] },
): { text: string; tags: string[] } {
  const tags = meta.hashtags.map((h) => h.replace(/^#/, '')).filter(Boolean);
  const max = VIDEO_CAPTION_LIMITS[dest].tags[1];
  const text =
    dest === 'x' || dest === 'bluesky' ? meta.title : `${meta.title}\n\n${meta.description}`.trim();
  return { text, tags: tags.slice(0, max) };
}

// ---- per-destination options (TikTok's Direct Post UX rules)

/** TikTok privacy levels as `creator_info` returns them. There is deliberately no default: the owner picks one per post. */
export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;

/**
 * What the owner chose for the TikTok post (stored with the post, used at the slot). Branded content cannot be private;
 * `consent` is the tick of "By posting, you agree to TikTok's ..." and must be true.
 */
export const TikTokOptionsSchema = z
  .object({
    privacy: z.enum(TIKTOK_PRIVACY_LEVELS),
    allowComment: z.boolean(),
    allowDuet: z.boolean(),
    allowStitch: z.boolean(),
    /** Commercial content disclosure: off by default. `yourBrand` = promotional content, `brandedContent` = paid partnership. */
    commercial: z.object({ on: z.boolean(), yourBrand: z.boolean(), brandedContent: z.boolean() }),
    consent: z.literal(true),
  })
  .refine((o) => !(o.commercial.on && !o.commercial.yourBrand && !o.commercial.brandedContent), {
    message: 'pick "Your brand" or "Branded content"',
    path: ['commercial'],
  })
  .refine((o) => !(o.commercial.on && o.commercial.brandedContent && o.privacy === 'SELF_ONLY'), {
    message: 'branded content cannot be private',
    path: ['privacy'],
  });
export type TikTokOptions = z.infer<typeof TikTokOptionsSchema>;

export const VideoDestinationOptionsSchema = z.object({ tiktok: TikTokOptionsSchema.optional() });
export type VideoDestinationOptions = z.infer<typeof VideoDestinationOptionsSchema>;

/** `YYYY-MM-DD` plus `n` days (calendar arithmetic, no time zone involved), and the weekday of such a date. */
export { addDays as addLocalDays, weekdayOf as weekdayOfDate };
