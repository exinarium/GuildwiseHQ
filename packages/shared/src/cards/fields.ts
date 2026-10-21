import { z } from 'zod';
import { FeedItemInputSchema } from '../feed/index.ts';
import { HttpUrlSchema } from '../safe.ts';
import { allowedOutcomes, skipInactive, type WorkflowCardView } from '../workflows/resolve.ts';
import { getStage, type Stage, type WorkflowDefinition } from '../workflows/schema.ts';

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
  /** Run the investigate & design stage (architect) before build. */
  designNeeded: { label: 'Investigate & design', kind: 'boolean' },
  /** The card only investigates: investigate -> finalize, no build. */
  investigationOnly: { label: 'Investigation only', kind: 'boolean' },
  riskTier: { label: 'Risk tier', kind: 'enum' },
  priority: { label: 'Priority', kind: 'number' },
};

/**
 * Flags the server derives when it evaluates a workflow (they are on no card): `manualQa` (the project has manual QA on and
 * the card is not an investigation-only card) and `qaAgent` (an agent of the tester or BA role is hired, so the QA steps
 * can be written). Workflows may use them in `when` (docs/design/manual-qa.md).
 */
export const DERIVED_BOOLEAN_FIELDS: Record<string, FieldMeta> = {
  manualQa: { label: 'Manual QA after Finalize', kind: 'boolean' },
  qaAgent: { label: 'An agent can write the QA steps', kind: 'boolean' },
  /** lean team: the owner approves the card after the review (decided when the last review approval comes in). */
  ownerApproval: { label: 'The owner approves after the review', kind: 'boolean' },
  /** lean team: a merge conflict at Finalize was resolved and the resolution goes to a merge review (server-driven; never true for an agent's outcome). */
  mergeReview: { label: 'Merge conflict resolution under review', kind: 'boolean' },
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
  /** Architect: the first report holds a fake secret, the runner refuses it, the report is rewritten and sent again. */
  'secret',
  /** The agent adds a backlog suggestion (`aom backlog suggest`) and then carries on normally. */
  'suggest',
]);
export type MockAction = z.infer<typeof MockActionSchema>;
/** `{ "<stage>": ["<action>", ...] }` consumed by round index. Example: `{ review: ['changes', 'ok'] }`. */
export const MockScriptSchema = z.record(z.string(), z.array(MockActionSchema));
export type MockScript = z.infer<typeof MockScriptSchema>;
/**
 * Mock runtime: the synthetic token use a card's shifts report (cost tracking and budget tests). Default 1000 input and
 * 200 output tokens per shift; `model` lets a test price the shift as another model.
 */
export const MockUsageSchema = z.object({
  inputTokens: z.number().int().min(0).max(1_000_000_000),
  outputTokens: z.number().int().min(0).max(1_000_000_000),
  cacheReadTokens: z.number().int().min(0).max(1_000_000_000).optional(),
  cacheWriteTokens: z.number().int().min(0).max(1_000_000_000).optional(),
  model: z.string().max(120).optional(),
});
export type MockUsage = z.infer<typeof MockUsageSchema>;

/**
 * Fields that only script the mock runtime. They are shown, and accepted by the API, only when the server runs with
 * `AOM_MOCK_UI=true` (dev and e2e).
 */
export const MOCK_FIELD_KEYS = [
  'mock',
  'mockEnv',
  'mockOutbound',
  'mockResearch',
  'mockFeed',
  'mockUsage',
] as const;
export const isMockField = (key: string): boolean => (MOCK_FIELD_KEYS as readonly string[]).includes(key);

// ------------------------------------------------------------------ code set

/** Relative, no `..` segments, not absolute; or `vault:<relative path>` under the same rules. */
export function isValidReportPath(value: string): boolean {
  const path = value.startsWith('vault:') ? value.slice('vault:'.length) : value;
  if (path.trim() === '' || path.length > 300) return false;
  if (path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path) || path.includes('\0'))
    return false;
  return !path.split(/[\\/]/).includes('..');
}
export const ReportPathSchema = z
  .string()
  .refine(isValidReportPath, 'must be a relative path without .. (optionally prefixed vault:)');

/** All keys optional: draft cards may be incomplete. Completeness is checked with `requiredMissing`. */
export const CodeFieldsSchema = z.object({
  context: z.string().optional(),
  requirements: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  affectedAreas: z.string().optional(),
  constraints: z.string().optional(),
  linkedLedgerIds: z.array(z.uuid()).optional(),
  testPlan: z.string().optional(),
  /**
   * Run the tester's `test` stage (integration and E2E tests against a running environment). Set from the project's
   * Run & test setting when the card is specified; the BA or manager may switch it off or on per card.
   */
  integrationTests: z.boolean().optional(),
  /** Architect report location override: relative path inside the worktree, or `vault:<path>`. */
  reportPath: ReportPathSchema.optional(),
  externalRef: z.string().optional(),
  mock: MockScriptSchema.optional(),
  /** Mock runtime: the usage each shift of this card reports. */
  mockUsage: MockUsageSchema.optional(),
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
  integrationTests: { label: 'Integration tests', kind: 'boolean' },
  reportPath: { label: 'Report path', kind: 'text' },
  externalRef: { label: 'External reference', kind: 'text' },
  mock: { label: 'Mock script', kind: 'json' },
  mockUsage: { label: 'Mock token usage', kind: 'json' },
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
  /** The kinds of item the interest wants (absent: all three). Items of another kind are dropped by the server. */
  kinds: z.array(z.enum(['article', 'video', 'podcast'])).optional(),
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
  kinds: { label: 'Kinds', kind: 'list' },
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
  const out: Record<string, FieldMeta> = { ...CARD_COLUMN_FIELDS, ...DERIVED_BOOLEAN_FIELDS };
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
  designNeeded?: boolean | null;
  investigationOnly?: boolean | null;
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
    // A card with no completion action of its own follows the project's default, which always exists.
    if (key === 'completionAction') return false;
    const top = (card as Record<string, unknown>)[key];
    if (key in CARD_COLUMN_FIELDS) return !isFilled(top);
    return !isFilled(card.fields?.[key]);
  });
}

/**
 * Card keys needed to specify the card: the `requiredFields` of the stage it enters plus those of every stage on its
 * success path to a terminal (first allowed success outcome of each stage, `when` skips and outcome guards honoured
 * against `card`). The entered stage is the target of the outcome with event `CardSpecified` (of `fromStageId`, else of
 * the first stage that has one). Unknown/missing spec outcome: empty. Order is path order, without duplicates.
 */
export function requiredForSpecify(
  def: Pick<WorkflowDefinition, 'stages'>,
  card: WorkflowCardView,
  fromStageId?: string,
): string[] {
  const from = fromStageId
    ? getStage(def, fromStageId)
    : def.stages.find((s) => s.outcomes.some((o) => o.event === 'CardSpecified'));
  const specified = from?.outcomes.find(
    (o) => o.event === 'CardSpecified' && allowedOutcomes(def, card, from.id).includes(o),
  );
  if (!from || !specified) return [];
  const keys: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = skipInactive(def, card, specified.to);
  while (current && !seen.has(current)) {
    seen.add(current);
    const stage = getStage(def, current);
    if (!stage || stage.kind === 'terminal') break;
    for (const k of stage.requiredFields) if (!keys.includes(k)) keys.push(k);
    const next = allowedOutcomes(def, card, stage.id).find((o) => o.kind === 'success');
    current = next ? skipInactive(def, card, next.to) : undefined;
  }
  return keys;
}

/** `requiredForSpecify` keys that are not filled on the card (card columns top level, field-set values under `fields`). */
export function missingForSpecify(
  def: Pick<WorkflowDefinition, 'stages'>,
  card: FillableCard & WorkflowCardView,
  fromStageId?: string,
): string[] {
  return requiredMissing(card, { requiredFields: requiredForSpecify(def, card, fromStageId) });
}
