import { z } from 'zod';
import { FeedItemInputSchema } from '../feed/index.ts';
import { HttpUrlSchema } from '../safe.ts';
import type { Stage } from '../workflows/schema.ts';

export type FieldKind =
  | 'text'
  | 'markdown'
  | 'list'
  | 'number'
  | 'boolean'
  | 'url-list'
  | 'enum'
  | 'uuid'
  | 'json';
export interface FieldMeta {
  label: string;
  kind: FieldKind;
}

/** Real card columns that workflows may reference in `requiredFields` / `when`. */
export const CARD_COLUMN_FIELDS: Record<string, FieldMeta> = {
  title: { label: 'Title', kind: 'text' },
  cardType: { label: 'Card type', kind: 'enum' },
  repoId: { label: 'Repository', kind: 'uuid' },
  completionAction: { label: 'Completion action', kind: 'enum' },
  docsNeeded: { label: 'Docs needed', kind: 'boolean' },
  riskTier: { label: 'Risk tier', kind: 'enum' },
  priority: { label: 'Priority', kind: 'number' },
};

// ---------------------------------------------------------------- mock script

export const MockActionSchema = z.enum([
  'ok',
  'changes',
  'fail',
  'question',
  'crash',
  'hang',
  'no_report',
  'edit_outside_scope',
  /** M3: the agent asks the DevOps engineer (`aom devops "start the app"`) and then carries on normally. */
  'devops',
  /** M3: like `devops` but for a request outside the default access ("install docker" needs approval). */
  'devops_install',
  /** M5: the scout also reports an item it never opened; the runner rejects it and the scout retries without it. */
  'fabricate',
  /** M6: the checker first tries to publish a note without citations (the runner refuses), then does it properly. */
  'uncited',
  /** M7: a question shift answers the question (`aom answer`) ... */
  'answer',
  /** ... or passes it on along the escalation chain (`aom escalate`). */
  'escalate',
]);
export type MockAction = z.infer<typeof MockActionSchema>;
/** `{ "<stage>": ["<action>", ...] }` consumed by round index. Example: `{ review: ['changes', 'ok'] }`. */
export const MockScriptSchema = z.record(z.string(), z.array(MockActionSchema));
export type MockScript = z.infer<typeof MockScriptSchema>;

/**
 * Fields that only script the mock runtime. They are shown, and accepted by the API, only when the server runs with
 * `AOM_MOCK_UI=true` (dev and e2e).
 */
export const MOCK_FIELD_KEYS = ['mock', 'mockEnv', 'mockOutbound', 'mockResearch', 'mockFeed'] as const;
export const isMockField = (key: string): boolean => (MOCK_FIELD_KEYS as readonly string[]).includes(key);

// ------------------------------------------------------------------ code set

/** All keys optional: draft cards may be incomplete. Completeness is checked with `requiredMissing`. */
export const CodeFieldsSchema = z.object({
  context: z.string().optional(),
  requirements: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  affectedAreas: z.string().optional(),
  constraints: z.string().optional(),
  linkedLedgerIds: z.array(z.uuid()).optional(),
  testPlan: z.string().optional(),
  externalRef: z.string().optional(),
  mock: MockScriptSchema.optional(),
  /** M4 regression and full-suite cards: the platform under test. */
  platform: z.enum(['web', 'mobile']).optional(),
  /** M4 suite cards: the branch the suite runs on (the pushed card branch for `pr` / `push_branch`; default: the working branch). */
  suiteBranch: z.string().optional(),
  /** Phase regression cards: run the suite against this deployed app (also exported to the tester as `AOM_TARGET_URL`). */
  targetUrl: HttpUrlSchema.optional(),
  /** Phase regression cards: the name of the deploy target the suite runs against. */
  deployTarget: z.string().max(120).optional(),
  /** M4 mock runtime: the test environment problem a tester shift finds until DevOps fixed it. */
  mockEnv: z.enum(['app_not_deployed', 'docker_missing']).optional(),
  /** M8 mock runtime: the update the mock BA drafts for the card's ticket (default: a plain resolution). */
  mockOutbound: z
    .object({ kind: z.enum(['comment', 'resolution', 'decision']).optional(), body: z.string().optional() })
    .optional(),
});
export type CodeFields = z.infer<typeof CodeFieldsSchema>;

export const CODE_FIELDS: Record<string, FieldMeta> = {
  context: { label: 'Context', kind: 'markdown' },
  requirements: { label: 'Requirements', kind: 'markdown' },
  acceptanceCriteria: { label: 'Acceptance criteria', kind: 'list' },
  affectedAreas: { label: 'Affected areas', kind: 'markdown' },
  constraints: { label: 'Constraints', kind: 'markdown' },
  linkedLedgerIds: { label: 'Linked ledger entries', kind: 'list' },
  testPlan: { label: 'Test plan', kind: 'markdown' },
  externalRef: { label: 'External reference', kind: 'text' },
  mock: { label: 'Mock script', kind: 'json' },
  platform: { label: 'Platform', kind: 'enum' },
  suiteBranch: { label: 'Suite branch', kind: 'text' },
  targetUrl: { label: 'Target URL', kind: 'text' },
  deployTarget: { label: 'Deploy target', kind: 'text' },
  mockEnv: { label: 'Mock test environment', kind: 'enum' },
  mockOutbound: { label: 'Mock outbound draft', kind: 'json' },
};

// -------------------------------------------------------------- research set

export const ResearchDepth = z.enum(['quick', 'standard', 'deep']);
export type ResearchDepth = z.infer<typeof ResearchDepth>;
/**
 * Mock adapter only: the claims a scripted researcher "finds" (each with the page that supports it). A claim with
 * `supported: false` is one the mock checker cannot verify against its page: the fact check fails and the card goes
 * back to the researcher, who drops it in the next round.
 */
export const MockResearchSchema = z.object({
  claims: z.array(
    z.object({
      text: z.string().min(1),
      url: z.url(),
      title: z.string().optional(),
      /** `video` or `podcast`: the mock researcher fetches its transcript. */
      kind: z.enum(['article', 'video', 'podcast']).optional(),
      supported: z.boolean().optional(),
    }),
  ),
});
export type MockResearch = z.infer<typeof MockResearchSchema>;

export const ResearchFieldsSchema = z.object({
  question: z.string().optional(),
  scope: z.string().optional(),
  depth: ResearchDepth.optional(),
  subCategory: z.string().optional(),
  preferredSites: z.array(z.string()).optional(),
  maxPerKind: z.record(z.string(), z.number().int().nonnegative()).optional(),
  mock: MockScriptSchema.optional(),
  mockResearch: MockResearchSchema.optional(),
});
export type ResearchFields = z.infer<typeof ResearchFieldsSchema>;

export const RESEARCH_FIELDS: Record<string, FieldMeta> = {
  question: { label: 'Question', kind: 'markdown' },
  scope: { label: 'Scope', kind: 'markdown' },
  depth: { label: 'Depth', kind: 'enum' },
  subCategory: { label: 'Sub-category', kind: 'text' },
  preferredSites: { label: 'Preferred sites', kind: 'url-list' },
  maxPerKind: { label: 'Max per kind', kind: 'json' },
  mock: { label: 'Mock script', kind: 'json' },
  mockResearch: { label: 'Mock research claims', kind: 'json' },
};

// ------------------------------------------------------------------ feed set

/** Mock adapter only: the pages a scripted scout "finds" (and whether the curator proposes a taste rule). */
export const MockFeedSchema = z.object({
  items: z.array(FeedItemInputSchema),
  proposeRule: z.string().optional(),
});
export type MockFeed = z.infer<typeof MockFeedSchema>;

const FeedFieldsBase = z.object({
  /** Short label of the feed ("Rust async"). */
  topic: z.string().optional(),
  /** Markdown: what the manager actually wants (angle, include/exclude, level). The primary statement of intent. */
  description: z.string().optional(),
  windowHours: z.number().int().positive().optional(),
  preferredSites: z.array(z.string()).optional(),
  /** Optional sub-category of the topic (e.g. `rust/async`); shown to the agents, never changes where files go. */
  subCategory: z.string().optional(),
  /** The digest holds the best N items overall, whatever their kind. */
  maxItems: z.number().int().positive().max(100).optional(),
  /** Legacy (read only): per-kind maxima, converted to `maxItems` on read. */
  maxPerKind: z.record(z.string(), z.number().int().nonnegative()).optional(),
  mock: MockScriptSchema.optional(),
  mockFeed: MockFeedSchema.optional(),
});

/** The overall maximum of a feed card's fields: `maxItems`, else the sum of a legacy `maxPerKind`, else the default. */
export function feedMaxItems(fields: Record<string, unknown> | undefined | null): number {
  const f = fields ?? {};
  if (typeof f.maxItems === 'number' && f.maxItems > 0) return f.maxItems;
  if (f.maxPerKind && typeof f.maxPerKind === 'object') {
    const sum = Object.values(f.maxPerKind as Record<string, unknown>).reduce<number>(
      (a, v) => a + (typeof v === 'number' && v > 0 ? v : 0),
      0,
    );
    if (sum > 0) return sum;
  }
  return FEED_DEFAULT_MAX_ITEMS;
}

export const FEED_DEFAULT_MAX_ITEMS = 10;

/** Accepts the legacy `maxPerKind` on read and converts it (sum of the values, else the default); new writes use `maxItems`. */
export const FeedFieldsSchema = FeedFieldsBase.transform(({ maxPerKind, ...rest }) =>
  maxPerKind !== undefined && rest.maxItems === undefined
    ? { ...rest, maxItems: Math.min(100, feedMaxItems({ maxPerKind })) }
    : rest,
);
export type FeedFields = z.infer<typeof FeedFieldsSchema>;

/** Stored defaults of a new feed card. `maxItems` is not stored: it is resolved on read (`feedMaxItems`) so a legacy `maxPerKind` is not shadowed. */
export const FEED_FIELD_DEFAULTS = { windowHours: 24 } as const;

export const FEED_FIELDS: Record<string, FieldMeta> = {
  topic: { label: 'Topic', kind: 'text' },
  description: { label: 'Description', kind: 'markdown' },
  windowHours: { label: 'Window (hours)', kind: 'number' },
  preferredSites: { label: 'Preferred sites', kind: 'url-list' },
  subCategory: { label: 'Sub-category', kind: 'text' },
  maxItems: { label: 'Max items', kind: 'number' },
  mock: { label: 'Mock script', kind: 'json' },
  mockFeed: { label: 'Mock feed items', kind: 'json' },
};

// ------------------------------------------------------------------ registry

export const FIELD_SETS = {
  code: { schema: CodeFieldsSchema, fields: CODE_FIELDS },
  research: { schema: ResearchFieldsSchema, fields: RESEARCH_FIELDS },
  feed: { schema: FeedFieldsSchema, fields: FEED_FIELDS },
} as const;
export type BuiltinFieldSet = keyof typeof FIELD_SETS;

export function isBuiltinFieldSet(id: string): id is BuiltinFieldSet {
  return Object.hasOwn(FIELD_SETS, id);
}

/** Keys (with kinds) that exist for a field set: card columns + the set's fields + custom fields. */
export function fieldCatalogue(
  fieldSet: string,
  customFields: ReadonlyArray<{ key: string; label: string; type: FieldKind }> = [],
): Record<string, FieldMeta> {
  const out: Record<string, FieldMeta> = { ...CARD_COLUMN_FIELDS };
  if (isBuiltinFieldSet(fieldSet)) Object.assign(out, FIELD_SETS[fieldSet].fields);
  for (const c of customFields) out[c.key] = { label: c.label, kind: c.type };
  return out;
}

/** Validates `cards.fields` against the field-set schema (built-in sets only; custom sets are accepted as-is). */
export function parseCardFields(
  fieldSet: string,
  fields: unknown,
): { success: true; data: Record<string, unknown> } | { success: false; error: z.ZodError } {
  if (!isBuiltinFieldSet(fieldSet)) {
    const r = z.record(z.string(), z.unknown()).safeParse(fields);
    return r.success ? { success: true, data: r.data } : { success: false, error: r.error };
  }
  const r = FIELD_SETS[fieldSet].schema.safeParse(fields);
  return r.success
    ? { success: true, data: r.data as Record<string, unknown> }
    : { success: false, error: r.error };
}

export function emptyFields(fieldSet: string): Record<string, unknown> {
  return fieldSet === 'feed' ? { ...FEED_FIELD_DEFAULTS } : {};
}

// ---------------------------------------------------------- required / filled

/** Card view for `requiredMissing`: real columns at the top level, field-set values under `fields`. */
export interface FillableCard {
  title?: string | null;
  cardType?: string | null;
  repoId?: string | null;
  completionAction?: string | null;
  docsNeeded?: boolean | null;
  riskTier?: string | null;
  priority?: number | null;
  fields?: Record<string, unknown> | null;
}

/** "Filled" = non-blank string, non-empty array, or any non-null value (false and 0 count as filled). */
export function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Keys from `stage.requiredFields` that are not filled on the card. */
export function requiredMissing(card: FillableCard, stage: Pick<Stage, 'requiredFields'>): string[] {
  return stage.requiredFields.filter((key) => {
    const top = (card as Record<string, unknown>)[key];
    if (key in CARD_COLUMN_FIELDS) return !isFilled(top);
    return !isFilled(card.fields?.[key]);
  });
}
