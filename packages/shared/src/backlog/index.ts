import { z } from 'zod';

/**
 * Project backlog: wanted work kept outside development until the owner sends it to the BA. The filter, the sort and
 * the card mapping live here so the server, the web and the CLI share one set of rules.
 */
export const BacklogPriority = z.enum(['critical', 'high', 'normal', 'low']);
export type BacklogPriority = z.infer<typeof BacklogPriority>;
export const BacklogStatus = z.enum(['open', 'done', 'dropped']);
export type BacklogStatus = z.infer<typeof BacklogStatus>;
export const BacklogSourceKind = z.enum(['owner', 'agent']);
export type BacklogSourceKind = z.infer<typeof BacklogSourceKind>;

export const BACKLOG_PRIORITY_LABEL: Record<BacklogPriority, string> = {
  critical: 'Critical',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};
export const BACKLOG_STATUS_LABEL: Record<BacklogStatus, string> = { open: 'Open', done: 'Done', dropped: 'Dropped' };
export const BACKLOG_PRIORITY_RANK: Record<BacklogPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };
/** The card priority (1 = most urgent … 9) each backlog priority becomes: the web levels Urgent 1, High 3, Normal 5, Low 8. */
export const BACKLOG_CARD_PRIORITY: Record<BacklogPriority, number> = { critical: 1, high: 3, normal: 5, low: 8 };

export const BACKLOG_TITLE_MAX = 300;
export const BACKLOG_DESCRIPTION_MAX = 8000;
export const BACKLOG_TAG_MAX = 40;
export const BACKLOG_TAGS_MAX = 20;
/** Items per bulk send. */
export const BACKLOG_SEND_MAX = 25;
/** Suggestions one agent shift may add. */
export const BACKLOG_SUGGEST_PER_SHIFT = 5;

/** Stored lower case. */
export const BacklogTag = z.string().trim().toLowerCase().min(1).max(BACKLOG_TAG_MAX);

const TagList = z
  .array(BacklogTag)
  .max(BACKLOG_TAGS_MAX)
  .transform((tags) => [...new Set(tags)]);
const Title = z.string().trim().min(1, 'A title is required').max(BACKLOG_TITLE_MAX);
const Description = z.string().max(BACKLOG_DESCRIPTION_MAX);

export const BacklogSourceDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner') }),
  z.object({
    kind: z.literal('agent'),
    agentId: z.uuid(),
    agentName: z.string(),
    cardRef: z.string().nullable(),
  }),
]);
export type BacklogSourceDto = z.infer<typeof BacklogSourceDto>;

export const BacklogItemDto = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  projectKey: z.string(),
  title: z.string(),
  description: z.string(),
  priority: BacklogPriority,
  tags: z.array(z.string()),
  flagged: z.boolean(),
  status: BacklogStatus,
  source: BacklogSourceDto,
  /** Set by Send to BA only. */
  cardRef: z.string().nullable(),
  cardId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BacklogItemDto = z.infer<typeof BacklogItemDto>;

export const CreateBacklogItemRequest = z.object({
  title: Title,
  description: Description.default(''),
  priority: BacklogPriority.default('normal'),
  tags: TagList.default([]),
  flagged: z.boolean().default(false),
});
export type CreateBacklogItemRequest = z.infer<typeof CreateBacklogItemRequest>;

/** Strict: `status`, `source` and the linked card are refused, not dropped. */
export const PatchBacklogItemRequest = z
  .object({
    title: Title.optional(),
    description: Description.optional(),
    priority: BacklogPriority.optional(),
    tags: TagList.optional(),
    flagged: z.boolean().optional(),
  })
  .strict();
export type PatchBacklogItemRequest = z.infer<typeof PatchBacklogItemRequest>;

export const SendBacklogRequest = z.object({ itemIds: z.array(z.uuid()).min(1).max(BACKLOG_SEND_MAX) });
export type SendBacklogRequest = z.infer<typeof SendBacklogRequest>;

export const BacklogSendResult = z.object({
  itemId: z.uuid(),
  title: z.string(),
  ok: z.boolean(),
  cardRef: z.string().optional(),
  cardId: z.uuid().optional(),
  note: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
});
export type BacklogSendResult = z.infer<typeof BacklogSendResult>;

export const BacklogSort = z.enum(['priority', 'created']);
export type BacklogSort = z.infer<typeof BacklogSort>;

/** Parses `a,b` (or a repeated key, or an array) into a list. */
const csv = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const parts = Array.isArray(v) ? v : [v];
    return parts.flatMap((p) => String(p).split(',')).map((s) => s.trim()).filter(Boolean);
  }, z.array(item).optional());

const flagParam = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional());

export const BacklogFilter = z.object({
  /** The default view is Open only (Done and Dropped are hidden until asked for). */
  status: z.preprocess(
    (v) => (v === undefined || v === '' ? undefined : Array.isArray(v) ? v : String(v).split(',').map((s) => s.trim()).filter(Boolean)),
    z.array(BacklogStatus).min(1).default(['open']),
  ),
  priority: csv(BacklogPriority),
  /** An item matches when it has ALL given tags. */
  tag: csv(z.string().trim().toLowerCase()),
  flagged: flagParam,
  source: BacklogSourceKind.optional(),
  /** Case-insensitive substring of the title, the description or any tag. */
  q: z.string().trim().max(200).optional(),
  sort: BacklogSort.default('priority'),
});
export type BacklogFilter = z.infer<typeof BacklogFilter>;

export function matchesBacklog(item: BacklogItemDto, f: BacklogFilter): boolean {
  if (!f.status.includes(item.status)) return false;
  if (f.priority?.length && !f.priority.includes(item.priority)) return false;
  if (f.tag?.length && !f.tag.every((t) => item.tags.includes(t))) return false;
  if (f.flagged !== undefined && item.flagged !== f.flagged) return false;
  if (f.source && item.source.kind !== f.source) return false;
  const q = f.q?.toLowerCase();
  if (q) {
    const hay = [item.title, item.description, ...item.tags].some((s) => s.toLowerCase().includes(q));
    if (!hay) return false;
  }
  return true;
}

/** Priority: Critical … Low, newest first within a priority. Created: newest first. Ties by id. */
export function compareBacklog(sort: BacklogSort): (a: BacklogItemDto, b: BacklogItemDto) => number {
  const newest = (a: BacklogItemDto, b: BacklogItemDto) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (sort === 'created') return newest;
  return (a, b) => BACKLOG_PRIORITY_RANK[a.priority] - BACKLOG_PRIORITY_RANK[b.priority] || newest(a, b);
}

export function filterBacklog(items: readonly BacklogItemDto[], f: BacklogFilter): BacklogItemDto[] {
  return items.filter((i) => matchesBacklog(i, f)).sort(compareBacklog(f.sort));
}

/** The text appended to the card's context when the item is sent: description, priority, tags and origin. */
export function backlogContextBlock(item: {
  title: string;
  description: string;
  priority: BacklogPriority;
  tags: readonly string[];
  source: BacklogSourceDto;
}): string {
  const body = item.description.trim() || item.title;
  const parts = [`From the project backlog. Priority: ${BACKLOG_PRIORITY_LABEL[item.priority]}.`];
  if (item.tags.length) parts.push(`Tags: ${item.tags.join(', ')}.`);
  if (item.source.kind === 'agent') {
    parts.push(
      `Suggested by ${item.source.agentName}${item.source.cardRef ? ` while working on ${item.source.cardRef}` : ''}.`,
    );
  }
  return `${body}\n\n---\n${parts.join(' ')}`;
}
