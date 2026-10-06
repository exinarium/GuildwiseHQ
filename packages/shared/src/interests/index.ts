import { z } from 'zod';
import { FEED_DEFAULT_MAX_ITEMS } from '../cards/fields.ts';
import type { CardTemplate } from '../events/schedule.ts';

/**
 * Interests (docs/design/interests.md): one statement per topic the manager cares about. The interest owns the feed
 * schedule that scans for it. Pure helpers shared by the server (commands, projections) and the web page.
 */

const Id = z.uuid();

/** The cadence of an interest's scan; `manual` means the schedule exists but never fires on its own. */
export const ScanSpecSchema = z.object({
  /** Standard 5-field cron expression, evaluated in `timezone`. */
  cron: z.string().min(1).max(100),
  /** IANA time zone. */
  timezone: z.string().min(1).max(60),
  windowHours: z.number().int().min(1).max(720),
  maxItems: z.number().int().min(1).max(100).default(FEED_DEFAULT_MAX_ITEMS),
  manual: z.boolean().default(false),
});
export type ScanSpec = z.infer<typeof ScanSpecSchema>;

export const InterestStatus = z.enum(['active', 'paused']);
export type InterestStatus = z.infer<typeof InterestStatus>;

/** The full snapshot an `InterestCreated` / `InterestUpdated` event carries. */
export const InterestBodySchema = z.object({
  interestId: Id,
  orgId: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(20000).default(''),
  feedProjectId: Id.nullable(),
  researchProjectId: Id.nullable(),
  subCategory: z.string().min(1).max(120).nullable().default(null),
  preferredSites: z.array(z.string().min(1).max(500)).max(50).default([]),
  /** Null when there is no feed project. */
  scan: ScanSpecSchema.nullable(),
  status: InterestStatus,
  /** The feed schedule it owns (created in the same append); null without a feed project. */
  scheduleId: Id.nullable(),
  /** The schedule it was adopted from, if any. */
  adoptedFrom: Id.optional(),
});
export type InterestBody = z.infer<typeof InterestBodySchema>;

/** One explicit taste rule of a feed project; `interestId` limits it to the cards of that interest. */
export const TasteSeedRuleSchema = z.object({
  text: z.string().trim().min(1).max(500),
  interestId: Id.nullable().default(null),
});
export type TasteSeedRule = z.infer<typeof TasteSeedRuleSchema>;
export const MAX_TASTE_SEED_RULES = 100;

/** Hours a scan looks back when the manager does not say: hourly 1, daily and weekdays 24, weekly 168, else 24. */
export function defaultWindowHours(cron: string): number {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return 24;
  const [minute = '', hour = '', dom = '', month = '', dow = ''] = f;
  const everyDay = dom === '*' && month === '*';
  if (everyDay && hour === '*' && dow === '*' && !minute.includes('*')) return 1;
  if (everyDay && dow === '*') return 24;
  if (everyDay && dow === '1-5') return 24;
  if (dom === '*' && month === '*' && /^[0-7](,[0-7])*$/.test(dow) && !dow.includes(',')) return 168;
  return 24;
}

/** Whether the schedule an interest owns should be enabled. */
export function scheduleEnabled(i: Pick<InterestBody, 'status' | 'scan' | 'feedProjectId'>): boolean {
  return i.status === 'active' && i.scan != null && !i.scan.manual && i.feedProjectId != null;
}

type TemplateInput = Pick<InterestBody, 'name' | 'description' | 'preferredSites' | 'subCategory' | 'scan'>;

/** The card template of the feed schedule an interest owns. */
export function interestCardTemplate(i: TemplateInput): CardTemplate {
  const description = i.description.trim();
  const sites = i.preferredSites.map((s) => s.trim()).filter(Boolean);
  return {
    title: i.name,
    cardType: 'feed',
    fields: {
      topic: i.name,
      ...(description ? { description } : {}),
      windowHours: i.scan?.windowHours ?? defaultWindowHours(i.scan?.cron ?? '0 7 * * *'),
      ...(sites.length ? { preferredSites: sites } : {}),
      maxItems: i.scan?.maxItems ?? FEED_DEFAULT_MAX_ITEMS,
      ...(i.subCategory ? { subCategory: i.subCategory } : {}),
    },
  };
}

type SyncInput = Pick<
  InterestBody,
  'name' | 'description' | 'preferredSites' | 'subCategory' | 'scan' | 'status' | 'feedProjectId'
>;

/** What the schedule of an interest has to do when the interest changes (docs/design/interests.md section 4.3). */
export type ScheduleSyncPlan =
  | { action: 'none' }
  | { action: 'create' }
  | { action: 'delete' }
  /** The feed project changed: the old schedule is deleted and a new one created. */
  | { action: 'replace' }
  | {
      action: 'update';
      /** Name or card template changed. */
      template: boolean;
      /** Cron or time zone changed, or the schedule was re-enabled: the next fire is recomputed. */
      reschedule: boolean;
      enabled: boolean;
    };

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The pure decision behind `syncSchedule`: which schedule events an interest edit needs. */
export function scheduleSyncPlan(before: SyncInput, after: SyncInput): ScheduleSyncPlan {
  if (!before.feedProjectId && !after.feedProjectId) return { action: 'none' };
  if (!before.feedProjectId) return { action: 'create' };
  if (!after.feedProjectId) return { action: 'delete' };
  if (before.feedProjectId !== after.feedProjectId) return { action: 'replace' };
  const template =
    before.name !== after.name || !sameJson(interestCardTemplate(before), interestCardTemplate(after));
  const cronChanged =
    before.scan?.cron !== after.scan?.cron || before.scan?.timezone !== after.scan?.timezone;
  const wasEnabled = scheduleEnabled(before);
  const enabled = scheduleEnabled(after);
  const reschedule = cronChanged || (enabled && !wasEnabled);
  if (!template && !reschedule && enabled === wasEnabled) return { action: 'none' };
  return { action: 'update', template, reschedule, enabled };
}

/** Prefill of the "Research this" dialog (docs/design/interests.md section 5). */
export function researchCardDefaults(
  i: Pick<InterestBody, 'name' | 'description' | 'subCategory' | 'preferredSites'>,
): {
  title: string;
  question: string;
  scope: string;
  subCategory: string;
  preferredSites: string[];
  depth: 'standard';
} {
  return {
    title: `Research: ${i.name}`.slice(0, 300),
    question: `What should I know now about ${i.name}?`,
    scope: i.description.trim(),
    subCategory: i.subCategory ?? '',
    preferredSites: [...i.preferredSites],
    depth: 'standard',
  };
}

/** A project key suggestion from a name: the upper-case initials (or leading letters), 2 to 6 characters. */
export function suggestProjectKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let key = '';
  if (words.length >= 2) key = words.map((w) => w[0] as string).join('');
  else if (words[0]) key = words[0];
  key = key.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]/.test(key)) key = `P${key}`;
  key = key.slice(0, 6);
  return key.length >= 2 ? key : `${key}X`.slice(0, 6);
}
