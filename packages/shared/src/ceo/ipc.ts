import { z } from 'zod';
import { TOPIC_AREAS, TOPIC_AUDIENCES } from '../blog/topic.ts';

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
  'draft-cards',
  /** `aom ceo order invoke`: the wake's CEO asks the server for a full-power turn that enforces one authorized order. */
  'invoke-order',
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
  /**
   * Which projects, repositories and areas a request belongs to (`aom ceo route "<request>"`, docs/design/project-graphs.md
   * section 8). Read-only. The workstation answers it from the organization graph in the organization vault; the server
   * only knows the verb.
   */
  z
    .object({
      op: z.literal('route'),
      q: z.string().trim().max(500).default(''),
      /** The links the code suggests (drafts) instead of a ranking: for the CEO to show the owner in chat. */
      drafts: z.boolean().default(false),
    })
    .refine((r) => r.drafts || r.q.length > 0, {
      message: 'give a request to route, or --drafts',
      path: ['q'],
    }),
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
  /**
   * `aom ceo correction record`: the owner said "you did X, I'd rather Y" in the chat (owner turns only; the server attaches the
   * source message). Writes the active `correction` memory at once; `remedy: 'undo'` takes the action back.
   */
  z.object({
    op: z.literal('correction'),
    action: z.uuid().optional(),
    text: z.string().trim().min(3).max(4000),
    rule: z.string().trim().min(3).max(1000),
    remedy: z.enum(['none', 'undo']).default('none'),
  }),
  /** The off-system job log (`aom ceo job start|log|repeats`). */
  z.object({
    op: z.literal('job'),
    sub: z.enum(['start', 'log', 'repeats']),
    kind: z.string().trim().min(1).max(60).optional(),
    why: z.string().max(1000).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    summary: z.string().max(2000).optional(),
    project: z.string().max(10).optional(),
    /** `log`: the main command the job was done with (its first word feeds the repeat rule: same command twice = automation). */
    command: z.string().max(200).optional(),
  }),
  /**
   * Research topics for the Guildwise blog (`aom ceo topic propose|list`, docs/design/ceo-blog-topics.md). `propose` gives
   * one generic question for problem notes (`from`: note ids), or for something the owner just said ("make that a blog
   * topic": no `from`). The server scrubs it; the owner reviews it.
   */
  z.object({
    op: z.literal('topic'),
    sub: z.enum(['propose', 'list']),
    question: z.string().trim().max(400).optional(),
    area: z.enum(TOPIC_AREAS).optional(),
    audience: z.enum(TOPIC_AUDIENCES).optional(),
    from: z.array(z.string().trim().min(8).max(40)).max(20).default([]),
  }),
  /** Standing orders with full power (`aom ceo order invoke|decline|done`). */
  z.object({
    op: z.literal('order'),
    sub: z.enum(['invoke', 'decline', 'done']),
    entryId: z.uuid().optional(),
    wake: z.uuid().optional(),
    why: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    /** `decline`: the question for the owner. */
    ask: z.string().max(2000).optional(),
    /** `done`: what happened, and the shell commands the turn ran. */
    summary: z.string().max(4000).optional(),
    commands: z.array(z.string().max(500)).max(200).optional(),
  }),
  /**
   * The runner's permission relay (docs section 14.1): `ask` raises the desk question "authorize this execution" and returns an
   * id, `poll` returns the answer. Only the runner's relay calls it, from an owner or order turn.
   */
  z.object({
    op: z.literal('permission'),
    sub: z.enum(['ask', 'poll']),
    askId: z.uuid().optional(),
    tool: z.string().max(200).optional(),
    /** The tool input, already redacted by the runner. */
    input: z.string().max(4000).optional(),
    reason: z.string().max(1000).optional(),
  }),
  /** `aom ceo devops --wait`: the state of a DevOps request the CEO filed. */
  z.object({ op: z.literal('devops_status'), requestId: z.uuid() }),
  /** `aom ceo dir add <path>`: an extra working directory of this conversation. */
  z.object({ op: z.literal('dir'), sub: z.enum(['add']), path: z.string().min(1).max(500) }),
  /** The runner reports that `aom runner restart` scheduled a restart (the server records and announces it). */
  z.object({ op: z.literal('restart'), reason: z.string().max(500).optional() }),
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
