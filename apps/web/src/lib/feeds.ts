import { type FeedVerdict, SCHEDULE_PRESETS } from '@aom/shared';

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

export const VERDICTS: ReadonlyArray<{ id: FeedVerdict; label: string; hint: string }> = [
  { id: 'useful', label: 'Useful', hint: 'More like this' },
  { id: 'irrelevant', label: 'Irrelevant', hint: 'Not what I follow' },
  { id: 'boring', label: 'Boring', hint: 'On topic but dull' },
];

export const verdictTone = (v: FeedVerdict): 'green' | 'red' | 'amber' =>
  v === 'useful' ? 'green' : v === 'irrelevant' ? 'red' : 'amber';
