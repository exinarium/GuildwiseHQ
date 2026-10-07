import { z } from 'zod';
import { FEED_DEFAULT_MAX_ITEMS, type ResearchDepth } from '../cards/fields.ts';
import { slugify } from '../ids.ts';

/**
 * Interests (docs/design/restructure.md Part D). An interest is an org-level statement of a topic, backed by a hidden
 * project (`projects.kind = 'interest'`) whose feed and research cards carry its runs. Pure helpers shared by the server
 * (commands, projections, data migration) and the web pages.
 */

const Id = z.uuid();

/** The cadence of an interest's scans (the run schedule); `manual` means it never runs on its own. */
export const ScanSpecSchema = z.object({
  /** Standard 5-field cron expression, evaluated in `timezone`. */
  cron: z.string().min(1).max(100),
  /** IANA time zone. */
  timezone: z.string().min(1).max(60),
  windowHours: z.number().int().min(1).max(720),
  /** Maximum number of items per run, across articles, videos and podcasts. */
  maxItems: z.number().int().min(1).max(100).default(FEED_DEFAULT_MAX_ITEMS),
  manual: z.boolean().default(false),
});
export type ScanSpec = z.infer<typeof ScanSpecSchema>;

/**
 * When results reach the manager (the delivery schedule). `immediate` puts every digest on the desk as soon as it is
 * posted; `scheduled` batches the items of every run since the last delivery into one digest at the cron time, and
 * pushes nothing in between.
 */
export const DeliverySpecSchema = z.object({
  mode: z.enum(['immediate', 'scheduled']),
  cron: z.string().min(1).max(100).default('0 7 * * 1-5'),
  timezone: z.string().min(1).max(60).default('UTC'),
});
export type DeliverySpec = z.infer<typeof DeliverySpecSchema>;
export const IMMEDIATE_DELIVERY: DeliverySpec = { mode: 'immediate', cron: '0 7 * * 1-5', timezone: 'UTC' };

export const InterestStatus = z.enum(['active', 'paused']);
export type InterestStatus = z.infer<typeof InterestStatus>;

export const InterestKind = z.enum(['article', 'video', 'podcast']);
export type InterestKind = z.infer<typeof InterestKind>;
export const ALL_INTEREST_KINDS: InterestKind[] = ['article', 'video', 'podcast'];

export const InterestDomain = z.enum(['work', 'personal']);

/**
 * The agents an interest prefers, by workflow role. A soft preference only: no claim window, any qualified, allowed
 * agent takes a run at once (it merely sorts ahead for the preferred agent).
 */
export const InterestAgentsSchema = z.object({
  scout: Id.optional(),
  curator: Id.optional(),
  researcher: Id.optional(),
  checker: Id.optional(),
});
export type InterestAgents = z.infer<typeof InterestAgentsSchema>;

/** The full snapshot an `InterestCreated` / `InterestUpdated` event carries. Fields of the first model stay optional so old events replay. */
export const InterestBodySchema = z.object({
  interestId: Id,
  orgId: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(20000).default(''),
  subCategory: z.string().min(1).max(120).nullable().default(null),
  preferredSites: z.array(z.string().min(1).max(500)).max(50).default([]),
  scan: ScanSpecSchema.nullable().default(null),
  status: InterestStatus,
  /** The creator's rank (1 guest .. 4 owner) in the interest's organization when it was created (docs/design/organizations.md 4.3). */
  creatorRank: z.number().int().min(1).max(4).optional(),
  // ---- Part D
  /** The hidden backing project (absent on events written before Part D; the data migration sets it). */
  projectId: Id.optional(),
  /** The vault folder name `interests/<slug>/`, immutable. */
  slug: z.string().min(1).max(60).optional(),
  domain: InterestDomain.optional(),
  kinds: z.array(InterestKind).min(1).max(3).default(ALL_INTEREST_KINDS),
  agents: InterestAgentsSchema.default({}),
  delivery: DeliverySpecSchema.default(IMMEDIATE_DELIVERY),
  nextScanAt: z.string().nullable().optional(),
  nextDeliveryAt: z.string().nullable().optional(),
  // ---- the first model (feed project, research project, owned schedule); read on replay only
  feedProjectId: Id.nullable().optional(),
  researchProjectId: Id.nullable().optional(),
  scheduleId: Id.nullable().optional(),
  adoptedFrom: Id.optional(),
});
export type InterestBody = z.infer<typeof InterestBodySchema>;

/** One explicit taste rule of a feed project (the first model: `interestId` limits it to that interest's cards). */
export const TasteSeedRuleSchema = z.object({
  text: z.string().trim().min(1).max(500),
  interestId: Id.nullable().default(null),
});
export type TasteSeedRule = z.infer<typeof TasteSeedRuleSchema>;
export const MAX_TASTE_SEED_RULES = 100;
export const MAX_INTEREST_TASTE_RULES = 100;

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

type TemplateInput = Pick<
  InterestBody,
  'name' | 'description' | 'preferredSites' | 'subCategory' | 'scan'
> & {
  kinds?: readonly string[] | undefined;
};

export interface InterestCardTemplate {
  title: string;
  cardType: 'feed';
  fields: Record<string, unknown>;
}

/** The feed card of one scan of an interest. */
export function interestCardTemplate(i: TemplateInput): InterestCardTemplate {
  const description = i.description.trim();
  const sites = i.preferredSites.map((s) => s.trim()).filter(Boolean);
  const kinds = (i.kinds ?? ALL_INTEREST_KINDS).filter((k) => ALL_INTEREST_KINDS.includes(k as InterestKind));
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
      ...(kinds.length > 0 && kinds.length < ALL_INTEREST_KINDS.length ? { kinds } : {}),
    },
  };
}

/** The fields of a research run of an interest ("Research this"); the question is the manager's, else a default. */
export function researchRunFields(
  i: Pick<InterestBody, 'name' | 'description' | 'subCategory' | 'preferredSites'>,
  opts: {
    question?: string | undefined;
    depth?: ResearchDepth | undefined;
    seedSources?: Array<{ title: string; url: string }>;
  } = {},
): Record<string, unknown> {
  const scope = i.description.trim();
  return {
    question: opts.question?.trim() || `What should I know now about ${i.name}?`,
    ...(scope ? { scope } : {}),
    depth: opts.depth ?? 'standard',
    // Notes of an interest go to `notes/` of its vault folder (or its sub-category folder when it has one).
    subCategory: i.subCategory ?? 'notes',
    ...(i.preferredSites.length ? { preferredSites: [...i.preferredSites] } : {}),
    ...(opts.seedSources?.length ? { seedSources: opts.seedSources } : {}),
  };
}

/** Prefill of the "Research this" dialog. */
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

/** The vault folder name of an interest, unique among `taken` (`rust-async`, `rust-async-2`, ...). */
export function interestSlug(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base = slugify(name, 48) || 'interest';
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const c = `${base}-${n}`.slice(0, 60);
    if (!used.has(c)) return c;
  }
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A project key for a backing project: 2 to 10 chars `^[A-Z][A-Z0-9]+$`, from the slug, numbered on a collision. */
export function interestBackingKey(slug: string, takenKeys: Iterable<string> = []): string {
  const taken = new Set([...takenKeys].map((k) => k.toUpperCase()));
  let base = slug.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]/.test(base)) base = `I${base}`;
  base = base.slice(0, 6);
  if (base.length < 2) base = `${base}X`.slice(0, 6);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n++) {
    const suffix = String(n);
    const c = `${base.slice(0, 10 - suffix.length)}${suffix}`;
    if (!taken.has(c)) return c;
  }
  return `${base.slice(0, 6)}${Math.floor(Math.random() * 9999)}`.slice(0, 10);
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

/** The vault folder of an interest in its domain vault. */
export const interestVaultDir = (slug: string): string => `interests/${slug}`;

/** Interest run lifecycle (docs/design/restructure.md section 3.4). */
export const InterestRunKind = z.enum(['scan', 'research']);
export type InterestRunKind = z.infer<typeof InterestRunKind>;
export const InterestRunTrigger = z.enum(['cron', 'manual', 'after_scan', 'migrated']);
export type InterestRunTrigger = z.infer<typeof InterestRunTrigger>;
export const InterestRunStatus = z.enum([
  'queued',
  'scanning',
  'curating',
  'researching',
  'checking',
  'published',
  'nothing',
  'failed',
  'cancelled',
]);
export type InterestRunStatus = z.infer<typeof InterestRunStatus>;
export const OPEN_RUN_STATUSES: InterestRunStatus[] = [
  'queued',
  'scanning',
  'curating',
  'researching',
  'checking',
];

/** Three failed fires in a row open the `interest_failing` notice. */
export const INTEREST_FAILURE_NOTICE_AFTER = 3;

/**
 * A short human label for a run schedule or delivery schedule cron (the common presets only; anything else shows as
 * the cron expression).
 */
export function describeCron(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return cron;
  const [m = '', h = '', dom = '', mon = '', dow = ''] = f;
  if (!/^\d+$/.test(m)) return cron;
  const time = /^\d+$/.test(h) ? `${h.padStart(2, '0')}:${m.padStart(2, '0')}` : null;
  if (dom === '*' && mon === '*' && time) {
    if (dow === '*') return `Daily at ${time}`;
    if (dow === '1-5') return `Weekdays at ${time}`;
    if (/^[0-7]$/.test(dow))
      return `${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'][Number(dow)]} at ${time}`;
  }
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') return `Hourly at :${m.padStart(2, '0')}`;
  return cron;
}

// ------------------------------------------------------------------------------------------------ vault files

export const INTEREST_DOC_FILE = 'INTEREST.md';
export const INTEREST_SECTION_ID = 'interest';
export const RUNS_FILE = 'runs.md';
export const RUNS_HEADER =
  '# Runs\n\nOne line per finished run, oldest first. Lines are only ever appended.\n\n';

/** The managed `interest` section of `INTEREST.md`: label, description, sites, cadence, kinds and agents. */
export function renderInterestDoc(
  i: Pick<InterestBody, 'name' | 'description' | 'subCategory' | 'preferredSites' | 'scan' | 'status'> & {
    kinds?: readonly string[] | undefined;
    delivery?: DeliverySpec | undefined;
    agents?: Record<string, string> | undefined;
  },
): string {
  const lines = [`# ${i.name.replace(/\s+/g, ' ').trim()}`, ''];
  if (i.description.trim()) lines.push(i.description.trim(), '');
  lines.push(`- Status: ${i.status === 'active' ? 'active' : 'paused'}`);
  if (i.subCategory) lines.push(`- Sub-category: ${i.subCategory}`);
  if (i.preferredSites.length) lines.push(`- Preferred sites: ${i.preferredSites.join(', ')}`);
  if (i.scan) {
    lines.push(
      `- Runs: ${i.scan.manual ? 'only when started by hand' : `${describeCron(i.scan.cron)} (${i.scan.timezone})`}`,
    );
    lines.push(`- Maximum items per run: ${i.scan.maxItems} across articles, videos and podcasts`);
  }
  if (i.delivery)
    lines.push(
      `- Delivery: ${i.delivery.mode === 'immediate' ? 'as soon as a run finishes' : `${describeCron(i.delivery.cron)} (${i.delivery.timezone})`}`,
    );
  if (i.kinds?.length) lines.push(`- Kinds: ${i.kinds.join(', ')}`);
  if (i.agents && Object.keys(i.agents).length)
    lines.push(
      `- Preferred agents: ${Object.entries(i.agents)
        .map(([r, a]) => `${r} ${a}`)
        .join(', ')}`,
    );
  return `${lines.join('\n')}\n`;
}

export const INTEREST_DOC_HEADER = '';

/** One line of `runs.md`. */
export function renderRunLine(r: {
  at: Date;
  kind: string;
  trigger: string;
  status: string;
  found: number | null | undefined;
  published: number | null | undefined;
  cardRef: string;
}): string {
  const what =
    r.kind === 'research'
      ? `research note${r.published ? '' : ' (none)'}`
      : `found ${r.found ?? '?'} -> published ${r.published ?? 0}`;
  return `- ${r.at.toISOString().slice(0, 16).replace('T', ' ')} ${r.kind} (${r.trigger}): ${what}, ${r.status}, ${r.cardRef}\n`;
}
