import {
  addLocalDays,
  composeCaption,
  defaultVideoCaption,
  graphemeCount,
  localDate,
  VIDEO_CAPTION_LIMITS,
  type VideoDestination,
  type VideoPhase,
  type VideoSchedule,
  WEEKDAYS,
  type Weekday,
  weekdayOfDate,
} from '@aom/shared';

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};
export const DESTINATION_LABEL: Record<VideoDestination, string> = {
  youtube: 'YouTube',
  facebook: 'Facebook',
  instagram: 'Instagram Reels',
  x: 'X',
  linkedin: 'LinkedIn',
  bluesky: 'Bluesky',
  tiktok: 'TikTok',
};

/** "The writer drafts 3 long and 3 Short scripts a week": the cap follows the ticked days. */
export function weeklyCapText(schedule: Pick<VideoSchedule, 'long' | 'short'>): string {
  const l = schedule.long.days.length;
  const s = schedule.short.days.length;
  if (l === 0 && s === 0) return 'The writer drafts no scripts: tick at least one day.';
  return `The writer drafts ${l} long and ${s} Short scripts a week.`;
}

/** A slot as the owner reads it: weekday, date and time on this computer's clock. */
export function slotLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
/** A slot's time of day in the schedule's time zone (the calendar columns are days of that zone). */
export function slotTime(iso: string, timeZone: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone });
}

export interface CalendarDay {
  /** `YYYY-MM-DD` in the schedule's time zone. */
  date: string;
  weekday: Weekday;
  today: boolean;
}
/** The next `n` days from today on the wall clock of `timeZone`. */
export function calendarDays(timeZone: string, now: Date, n = 14): CalendarDay[] {
  const today = localDate(now.getTime(), timeZone);
  return Array.from({ length: n }, (_, i) => {
    const date = addLocalDays(today, i);
    return { date, weekday: weekdayOfDate(date), today: i === 0 };
  });
}
export const dayHeading = (d: CalendarDay): string => {
  const [y, m, day] = d.date.split('-').map(Number) as [number, number, number];
  const label = new Date(Date.UTC(y, m - 1, day)).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return `${WEEKDAY_LABEL[d.weekday].slice(0, 3)} ${label}`;
};
export const isWeekday = (v: string): v is Weekday => (WEEKDAYS as readonly string[]).includes(v);

// ---- captions

export interface Caption {
  text: string;
  tags: string[];
}
/** The caption the owner starts from for a destination: the description's hook and the hashtags (no link). */
export const defaultCaption = defaultVideoCaption;

const UNLIMITED = { total: 1_000_000, text: 1_000_000, title: 1_000_000 };
export function limitOf(dest: VideoDestination): number {
  const l = VIDEO_CAPTION_LIMITS[dest] as { total?: number; text?: number; title?: number };
  return l.total ?? l.text ?? l.title ?? 0;
}
/** What the destination will post for this caption, and how long it is before any cut (so an overflow shows). */
export function captionStats(dest: VideoDestination, c: Caption) {
  const full = composeCaption(dest, c.text, c.tags, '', UNLIMITED).text;
  const count = graphemeCount(full);
  const max = limitOf(dest);
  const posted = composeCaption(dest, c.text, c.tags, '').text;
  const [minTags, maxTags] = VIDEO_CAPTION_LIMITS[dest].tags;
  return { count, max, over: count > max, posted, tagsOver: c.tags.length > maxTags, minTags, maxTags };
}

// ---- phases

export const PHASE_LABEL: Record<VideoPhase, string> = {
  scripted: 'Scripted',
  in_review: 'In review',
  scheduled: 'Scheduled',
  rendering: 'Rendering',
  rendered: 'Rendered',
  publishing: 'Publishing',
  published: 'Published',
  partial: 'Partly published',
  failed: 'Failed',
  rejected: 'Rejected',
};
export const PHASE_TONE: Record<VideoPhase, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  scripted: 'neutral',
  in_review: 'warning',
  scheduled: 'info',
  rendering: 'info',
  rendered: 'info',
  publishing: 'warning',
  published: 'success',
  partial: 'warning',
  failed: 'danger',
  rejected: 'danger',
};

/** A share or upload URL is shown as a link only when it is https (a stored value is never trusted to be a safe scheme). */
export const safeHref = (url: string | null | undefined): string | null =>
  url && /^https:\/\//i.test(url) ? url : null;
