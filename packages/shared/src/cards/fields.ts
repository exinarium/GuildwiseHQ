import { z } from 'zod';
import { FeedItemInputSchema } from '../feed/index.ts';
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
]);
export type MockAction = z.infer<typeof MockActionSchema>;
/** `{ "<stage>": ["<action>", ...] }` consumed by round index. Example: `{ review: ['changes', 'ok'] }`. */
export const MockScriptSchema = z.record(z.string(), z.array(MockActionSchema));
export type MockScript = z.infer<typeof MockScriptSchema>;

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
};

// -------------------------------------------------------------- research set

export const ResearchDepth = z.enum(['quick', 'standard', 'deep']);
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

export const FeedFieldsSchema = z.object({
  topic: z.string().optional(),
  windowHours: z.number().int().positive().optional(),
  preferredSites: z.array(z.string()).optional(),
  maxPerKind: z.record(z.string(), z.number().int().nonnegative()).optional(),
  mock: MockScriptSchema.optional(),
  mockFeed: MockFeedSchema.optional(),
});
export type FeedFields = z.infer<typeof FeedFieldsSchema>;

export const FEED_FIELD_DEFAULTS = { windowHours: 24, maxPerKind: { article: 5, video: 3 } } as const;

export const FEED_FIELDS: Record<string, FieldMeta> = {
  topic: { label: 'Topic', kind: 'text' },
  windowHours: { label: 'Window (hours)', kind: 'number' },
  preferredSites: { label: 'Preferred sites', kind: 'url-list' },
  maxPerKind: { label: 'Max per kind', kind: 'json' },
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
