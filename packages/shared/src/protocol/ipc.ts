import { z } from 'zod';
import { ReviewData, TestEvidence } from '../cards/types.ts';
import { DevopsApprovalDataSchema, DevopsDoneDataSchema } from '../devops/index.ts';
import { CandidatesDataSchema, DigestDataSchema } from '../feed/index.ts';
import { AnswerReportSchema, EscalateReportSchema, FinalizeReportDataSchema } from '../intake/index.ts';
import {
  FollowupDoneDataSchema,
  FollowupFailedDataSchema,
  PhaseReadyDataSchema,
  PhaseReportDataSchema,
  PhaseResultsDataSchema,
} from '../phases/index.ts';
import { PublicationOutcomeSchema } from '../research/index.ts';

/**
 * `aom` CLI <-> runner IPC (docs/ARCHITECTURE.md section 13.4). HTTP on 127.0.0.1:<ephemeral>,
 * `Authorization: Bearer <AOM_SHIFT_TOKEN>`; POST `${AOM_IPC_URL}/v1/report` and `/v1/rpc`.
 */

export const IPC_REPORT_PATH = '/v1/report';
export const IPC_RPC_PATH = '/v1/rpc';

/** Sugar verbs all map to `outcome`. `data` is validated against the outcome's `data` kind (see `outcomeDataSchema`). */
export const OutcomeReportSchema = z.object({
  kind: z.literal('outcome'),
  outcomeId: z.string().min(1),
  note: z.string().min(1).max(20000),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const QuestionReportSchema = z.object({
  kind: z.literal('question'),
  text: z.string().min(1).max(20000),
  options: z.array(z.string().min(1)).default([]),
  /** Zero-based index into `options`. */
  recommend: z.number().int().nonnegative().optional(),
  doing: z.string().default(''),
  blocking: z.boolean().default(true),
  /** Ask even though the ledger already has a matching entry (non-blocking questions need this). */
  force: z.boolean().default(false),
});

/** Non-terminal thread message. */
export const CommentReportSchema = z.object({
  kind: z.literal('comment'),
  note: z.string().min(1).max(20000),
});

export const ShiftReportSchema = z.discriminatedUnion('kind', [
  OutcomeReportSchema,
  QuestionReportSchema,
  CommentReportSchema,
  /** M7: a question shift answers the desk item it was given (`aom answer`) ... */
  AnswerReportSchema,
  /** ... or passes it on along the escalation chain (`aom escalate`). */
  EscalateReportSchema,
]);
export type ShiftReport = z.infer<typeof ShiftReportSchema>;

/** Terminal reports end the shift (exactly one per shift; a second gets 409 already reported). */
export const isTerminalReport = (r: ShiftReport): boolean =>
  r.kind === 'outcome' ||
  r.kind === 'answer' ||
  r.kind === 'escalate' ||
  (r.kind === 'question' && r.blocking);

/** Data attached to an outcome report, by the outcome's `data` kind. `diffStats` is attached by the runner, not the agent. */
export function outcomeDataSchema(kind: string): z.ZodType {
  switch (kind) {
    case 'review':
      return ReviewData;
    case 'testEvidence':
      return TestEvidence;
    case 'devopsDone':
      return DevopsDoneDataSchema;
    case 'devopsApproval':
      return DevopsApprovalDataSchema;
    case 'candidates':
      return CandidatesDataSchema;
    case 'digest':
      return DigestDataSchema;
    case 'publication':
      return PublicationOutcomeSchema;
    case 'finalize':
      return FinalizeReportDataSchema;
    case 'phaseReport':
      return PhaseReportDataSchema;
    case 'phaseReady':
      return PhaseReadyDataSchema;
    case 'followupDone':
      return FollowupDoneDataSchema;
    case 'followupFailed':
      return FollowupFailedDataSchema;
    case 'phaseResults':
      return PhaseResultsDataSchema;
    default:
      return z.record(z.string(), z.unknown());
  }
}

/** A ledger entry returned by `aom ledger search` and by the duplicate check on `aom question`. */
export const LedgerMatchSchema = z.object({
  id: z.string(),
  scope: z.enum(['feature', 'decision', 'standing_order']),
  title: z.string(),
  body: z.string(),
  rank: z.number().optional(),
});
export type LedgerMatch = z.infer<typeof LedgerMatchSchema>;

export const LedgerSearchParamsSchema = z.object({
  query: z.string().min(1).max(500),
  scope: z.enum(['all', 'feature', 'decision', 'standing_order']).default('all'),
});
export const LedgerSearchResultSchema = z.object({ entries: z.array(LedgerMatchSchema) });
export type LedgerSearchResult = z.infer<typeof LedgerSearchResultSchema>;

/** Renders ledger matches for the agent's terminal (shared by the CLI and server messages). */
export function formatLedgerMatches(entries: readonly LedgerMatch[]): string {
  if (entries.length === 0) return 'No matching ledger entries.';
  return entries
    .map((e) => `- [${e.scope}] ${e.title} (id ${e.id})\n  ${e.body.trim().replace(/\n/g, '\n  ')}`)
    .join('\n');
}

export const IpcReportRequestSchema = z.object({ report: ShiftReportSchema });
export type IpcReportRequest = z.infer<typeof IpcReportRequestSchema>;

export const IpcReportResponseSchema = z.object({
  accepted: z.boolean(),
  /** Printed by the CLI. On acceptance: "Recorded. Finish now; do not make further changes." */
  message: z.string(),
  error: z.string().optional(),
  /** Set on a rejected report so the CLI can show the guard violation and the agent can retry in the same shift. */
  guardViolations: z.array(z.object({ rule: z.string(), detail: z.string() })).optional(),
  /** Ledger entries that already cover a question (stored on its desk item). */
  matches: z.array(LedgerMatchSchema).optional(),
});
export type IpcReportResponse = z.infer<typeof IpcReportResponseSchema>;

export const RpcMethodSchema = z.enum([
  'card.get',
  'ledger.search',
  'thread.post',
  'thread.read',
  'devops.request',
  /** M7, BA intake chat: draft and specify cards, map the ticket to a project, ask the manager when it cannot. */
  'card.create',
  'card.update',
  'card.specify',
  'intake.map',
  'intake.unmapped',
  /** M7, answered by the runner itself (credentials stay on the workstation): read a GitHub issue with `gh`. */
  'source.read',
  /** M8, the BA's finalize shift: draft the update for the card's ticket (the manager approves it on the desk). */
  'outbound.draft',
  /** The BA's finalize shift: override the card's risk tier (small or large) with a reason. */
  'card.risk',
  /** M10, the BA's design chat: draft roles and workflows for the owner's organization (they approve on the desk). */
  'org.catalogue',
  'org.role.draft',
  'org.workflow.draft',
  'org.validate',
  'org.submit',
  'org.department',
  /** Approved repository setup: the BA (chat) or the DevOps engineer asks; the project owner approves on the desk. */
  'repo.create',
  /** Videos and podcasts: `transcript.fetch` is answered by the runner itself; `transcript.store` goes on to the site. */
  /** The DevOps engineer runs a command with the stored sudo password; answered by the runner itself. */
  'sudo.run',
  /** The DevOps engineer checks or starts this workstation's login to a code host; answered by the runner itself. */
  'git.status',
  'git.connect',
  'transcript.fetch',
  'transcript.store',
  /** Phases, the BA's intake chat: list phases and deploy targets, propose a phase, assign cards, submit for confirmation. */
  'phase.list',
  'phase.propose',
  'phase.assign',
  'phase.submit',
  /** Phases, a `followups_brief` BA task: delegate one follow-up. */
  'phase.followup.brief',
]);
export type RpcMethod = z.infer<typeof RpcMethodSchema>;

export const IpcRpcRequestSchema = z.object({
  method: RpcMethodSchema,
  params: z.record(z.string(), z.unknown()).default({}),
});
export type IpcRpcRequest = z.infer<typeof IpcRpcRequestSchema>;

export const IpcRpcResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type IpcRpcResponse = z.infer<typeof IpcRpcResponseSchema>;

export const IpcErrorResponseSchema = z.object({ error: z.string() });
