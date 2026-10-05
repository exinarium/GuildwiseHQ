import { FEED_DEFAULT_MAX_ITEMS, FEED_FIELD_DEFAULTS, type FeedVerdict, SCHEDULE_PRESETS } from '@aom/shared';

/** A readable name for a cron expression: the preset it equals, else the expression itself. */
export function describeCron(cron: string): string {
  const c = cron.trim().replace(/\s+/g, ' ');
  return SCHEDULE_PRESETS.find((p) => p.cron === c)?.label ?? `Cron ${c}`;
}

/** The browser's time zone (what the Schedules form preselects), `UTC` when unknown. */
export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** One preferred site per line or comma separated; blanks dropped. */
export function parseSites(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface FeedTemplateInput {
  title: string;
  /** Short label. */
  topic: string;
  /** Markdown: what the manager actually wants (optional but encouraged). */
  description?: string;
  sites: string;
  /** The best N items overall, whatever their kind. */
  maxItems: string;
  windowHours?: string;
}

const count = (s: string, fallback: number): number => {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** The card template of a feed schedule from the form values (description, maximum items overall, preferred sites, window). */
export function buildFeedTemplate(i: FeedTemplateInput) {
  const sites = parseSites(i.sites);
  const description = (i.description ?? '').trim();
  const maxItems = count(i.maxItems, FEED_DEFAULT_MAX_ITEMS);
  const windowHours = count(i.windowHours ?? '', FEED_FIELD_DEFAULTS.windowHours);
  return {
    title: i.title.trim(),
    cardType: 'feed',
    fields: {
      topic: i.topic.trim(),
      ...(description ? { description } : {}),
      windowHours: windowHours > 0 ? windowHours : FEED_FIELD_DEFAULTS.windowHours,
      ...(sites.length ? { preferredSites: sites } : {}),
      maxItems: maxItems > 0 ? maxItems : FEED_DEFAULT_MAX_ITEMS,
    },
  };
}

export const VERDICTS: ReadonlyArray<{ id: FeedVerdict; label: string; hint: string }> = [
  { id: 'useful', label: 'Useful', hint: 'More like this' },
  { id: 'irrelevant', label: 'Irrelevant', hint: 'Not what I follow' },
  { id: 'boring', label: 'Boring', hint: 'On topic but dull' },
];

export const verdictTone = (v: FeedVerdict): 'green' | 'red' | 'amber' =>
  v === 'useful' ? 'green' : v === 'irrelevant' ? 'red' : 'amber';
