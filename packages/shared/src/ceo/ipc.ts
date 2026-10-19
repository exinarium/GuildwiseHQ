import { z } from 'zod';

/**
 * `aom ceo ...` over the runner IPC (docs/design/ceo-agent-v2.md section 4): one rpc method `ceo` with an `op`. The runner
 * forwards it unchanged to the server, which accepts it only from a shift or chat of the organization's CEO.
 */

export const CEO_ACTIONS = [
  'answer',
  'triage',
  'resolve-notice',
  'release',
  'release-backoff',
  'reassign',
  'priority',
  'cancel-card',
  'stop-shift',
  'kill-tools',
  'pause-agent',
  'resume-agent',
  'model',
  'seniority',
  'allow',
  'hire',
  'bench',
  'retire',
  'scale',
  'apply-rec',
  'devops',
  'propose-order',
  'activate-order',
  'retire-entry',
  'message',
  'intake',
  'specify',
] as const;
export const CeoActionName = z.enum(CEO_ACTIONS);
export type CeoActionName = z.infer<typeof CeoActionName>;

const Reasoned = {
  reason: z.string().trim().min(3).max(2000),
  confidence: z.number().min(0).max(1),
  /** Ids the decision rests on: `ledger:<id>`, `memory:<id>`, `signal:<id>`, `hr:<id>`, `desk:<id>`. */
  evidence: z.array(z.string().min(1).max(100)).max(20).default([]),
};

export const CeoActRpc = z.object({
  op: z.literal('act'),
  action: CeoActionName,
  params: z.record(z.string(), z.unknown()).default({}),
  ...Reasoned,
  key: z.string().min(1).max(200).optional(),
  dryRun: z.boolean().default(false),
});

export const CeoRpcSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('snapshot'), section: z.string().max(40).optional() }),
  z.object({
    op: z.literal('show'),
    kind: z.enum(['card', 'agent', 'project', 'shift', 'desk-item', 'workstation']),
    ref: z.string().min(1).max(200),
  }),
  z.object({
    op: z.literal('search'),
    in: z.enum(['desk', 'cards', 'memory']),
    q: z.string().min(1).max(300),
  }),
  z.object({ op: z.literal('costs'), days: z.number().int().min(1).max(90).default(30) }),
  CeoActRpc,
  z.object({
    op: z.literal('recommend'),
    item: z.uuid().optional(),
    option: z.string().max(40).optional(),
    text: z.string().max(4000).optional(),
    action: CeoActionName.optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    urgent: z.boolean().default(false),
    ...Reasoned,
    key: z.string().min(1).max(200).optional(),
  }),
  z.object({
    op: z.literal('notify'),
    kind: z.enum(['needs_you', 'urgent', 'task_done']),
    text: z.string().trim().min(1).max(4000),
    title: z.string().trim().min(1).max(200).optional(),
    task: z.uuid().optional(),
    item: z.uuid().optional(),
    key: z.string().min(1).max(200).optional(),
  }),
  z.object({
    op: z.literal('task'),
    sub: z.enum(['create', 'update', 'list']),
    id: z.uuid().optional(),
    title: z.string().trim().min(1).max(300).optional(),
    request: z.string().max(4000).optional(),
    status: z
      .enum(['open', 'in_progress', 'waiting_owner', 'waiting_work', 'done', 'failed', 'cancelled'])
      .optional(),
    note: z.string().max(4000).optional(),
    due: z.iso.datetime().optional(),
    watch: z
      .array(z.object({ kind: z.enum(['card', 'devops', 'desk', 'agent']), id: z.string().min(1) }))
      .optional(),
  }),
  /** The CEO's turn in the discussion after the owner corrected one of its decisions (`aom ceo review-reply`). */
  z.object({
    op: z.literal('review_reply'),
    item: z.uuid(),
    stance: z.enum(['agree', 'disagree']),
    /** What it got wrong and why. */
    reflection: z.string().trim().min(3).max(2000),
    /** The rule for next time, in the CEO's own words. */
    lesson: z.string().trim().min(3).max(1000),
    /** Comments on the BA's proposed fix cards. */
    cardChanges: z.string().trim().max(2000).optional(),
  }),
  z.object({
    op: z.literal('memory'),
    sub: z.enum(['propose', 'confirm']),
    id: z.uuid().optional(),
    text: z.string().trim().min(1).max(1000).optional(),
    kind: z.enum(['rule', 'preference', 'decision_pattern', 'fact']).default('rule'),
    /** `owner_chat` (the owner said it in the CEO chat) or `desk:<itemId>` (the owner's own answer). */
    source: z.string().min(1).max(100).optional(),
    quote: z.string().max(1000).optional(),
    scope: z.string().max(100).default('org'),
  }),
]);
export type CeoRpc = z.infer<typeof CeoRpcSchema>;

export const CeoActResultSchema = z.object({
  status: z.enum(['executed', 'recommended', 'refused', 'dry_run', 'duplicate']),
  actionId: z.string().optional(),
  message: z.string(),
  mode: z.enum(['decided', 'recommended', 'refused']).optional(),
  deskItemId: z.string().optional(),
  wouldBe: z.enum(['decided', 'recommended', 'refused']).optional(),
  result: z.unknown().optional(),
});
export type CeoActResult = z.infer<typeof CeoActResultSchema>;

/** Terminal outcomes of a CEO shift (`aom ceo done|report`). */
export const CEO_OUTCOME = { done: 'ceo_done', report: 'ceo_report' } as const;
export const CeoDoneDataSchema = z.object({ summary: z.string().trim().min(1).max(8000) });
export const CeoReportDataSchema = z.object({
  /** Markdown report. */
  report: z.string().trim().min(1).max(40000),
});

/** What a CEO shift is for. */
export const CeoShiftSchema = z.object({
  purpose: z.enum(['wake', 'review']),
  batchId: z.uuid(),
  wakeIds: z.array(z.uuid()),
  /** The reasons, compact (untrusted text inside is already fenced in `brief`). */
  reasons: z.array(
    z.object({ reason: z.string(), urgency: z.string(), subject: z.string(), at: z.string() }),
  ),
  /** Fully rendered prompt body for the session (snapshot, events, memories, policy in plain words). */
  brief: z.string(),
  localDate: z.string().optional(),
});
export type CeoShift = z.infer<typeof CeoShiftSchema>;
