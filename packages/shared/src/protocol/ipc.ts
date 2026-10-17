import { z } from 'zod';
import { ReviewData, TestEvidence } from '../cards/types.ts';
import { CeoDoneDataSchema, CeoReportDataSchema } from '../ceo/ipc.ts';
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
import { QuestionTopicSchema } from '../questions/index.ts';
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
  /** Lean Team v3: the problem the question is about; the server routes by it (`aom question --topic`). */
  topic: QuestionTopicSchema.optional(),
  /** `aom question --wait`: raised non-blocking; the CLI polls `question.status` inside the shift. */
  wait: z.boolean().default(false),
  /** A waiting question ran out of time: this report turns the shift's open waiting question into a blocking one. */
  converts: z.boolean().default(false),
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

/** One assumption of a design made before the card's dependencies landed (owner decision #80). */
export const DesignAssumptionSchema = z.object({
  assumption: z.string().min(1).max(1000),
  /** The ref of the unlanded dependency the assumption is about. */
  dependency: z.string().min(1).max(40),
  /** What would change in the design if the assumption is wrong. */
  ifWrong: z.string().min(1).max(1000),
});
export type DesignAssumption = z.infer<typeof DesignAssumptionSchema>;

/** The assumption review after the dependencies landed: `aom design confirm` / `aom design revise`. */
export const DesignReviewDataSchema = z.object({
  decision: z.enum(['confirm', 'revise']),
  /** 1-based numbers of the assumptions the design was revised for (the others were confirmed). */
  revised: z.array(z.number().int().positive()).max(100).default([]),
  note: z.string().max(4000).default(''),
});
export type DesignReviewData = z.infer<typeof DesignReviewDataSchema>;

/** Architect outcome data (`aom design` / `aom investigate`): where the report is and a short summary for the next stage. */
export const InvestigationDataSchema = z.object({
  reportPath: z.string().min(1),
  summary: z.string().max(2000),
  location: z.enum(['repo', 'vault']),
  /** Filled by the runner (HEAD of the card branch) for a `repo` report. */
  commit: z.string().optional(),
  /** Filled by the runner for a `repo` report written without a card branch: the text the builder commits later. */
  body: z.string().max(200_000).optional(),
  /** A design made before dependencies landed lists what it assumed about them (at least one, unless `noAssumptions`). */
  assumptions: z.array(DesignAssumptionSchema).max(50).optional(),
  /** The architect states the design assumes nothing about the unlanded dependencies. */
  noAssumptions: z.string().max(1000).optional(),
  /** Set by the assumption-review shift (`aom design confirm|revise`). */
  review: DesignReviewDataSchema.optional(),
});
export type InvestigationData = z.infer<typeof InvestigationDataSchema>;

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
    case 'investigation':
      return InvestigationDataSchema;
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
    case 'ceoDone':
      return CeoDoneDataSchema;
    case 'ceoReport':
      return CeoReportDataSchema;
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

/** Params of `investigation.record` (`aom investigation record`). */
export const InvestigationRecordParamsSchema = z.object({
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(20000),
  /** Record it as a decision (scope `decision`) instead of a feature entry. */
  decision: z.boolean().default(false),
});
export type InvestigationRecordParams = z.infer<typeof InvestigationRecordParamsSchema>;

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
  /** The BA retires a ledger entry with a reason (`aom ledger retire <id> --reason "<why>"`). */
  'ledger.retire',
  'thread.post',
  'thread.read',
  'devops.request',
  /** A DevOps request filed for a card: comment on that one card (`aom card comment`); read and update use `card.get`/`card.update`. */
  'card.comment',
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
  'org.workflowVariant',
  'org.validate',
  'org.submit',
  'org.department',
  /** Approved repository setup: the BA (chat) or the DevOps engineer asks; the project owner approves on the desk. */
  'repo.create',
  /** Videos and podcasts: `transcript.fetch` is answered by the runner itself; `transcript.store` goes on to the site. */
  /** The DevOps engineer runs a command with the stored sudo password; answered by the runner itself. */
  'sudo.run',
  /** The DevOps guard hook (a Bash PreToolUse hook) reports the commands it saw; answered by the runner itself. */
  'devops.audit',
  'toolchain.list',
  'toolchain.add',
  'toolchain.remove',
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
  /** Architect, runner-mediated git: push the card branch, fetch origin, merge the latest main, verify a conflict resolution. Answered by the runner itself. */
  'git.push',
  'git.fetch',
  'git.merge_main',
  'git.verify_merge',
  /** DevOps repository hygiene, answered by the runner itself: the shifts with a running worktree, and a pull request's state. */
  'hygiene.busy_worktrees',
  'hygiene.change_state',
  /** The BA's finalize shift on an investigation-only card: record the result in the ledger and PROJECT.md. */
  'investigation.record',
  /** Attachments: Jira files downloaded by the runner (`source.*`, answered by the runner), a card's files copied next to the shift, a file the BA attaches to a card of its intake. */
  'source.attachments',
  'source.attachment',
  'card.attachments',
  'card.attach',
  'card.attach.begin',
  /** The DevOps engineer of a `run` request starts and checks the services of its environment; answered by the runner itself. */
  'run.info',
  'run.step',
  'run.service',
  'run.status',
  'run.logs',
  'run.ready',
  'run.fail',
  /** The CEO agent's management verbs (`aom ceo ...`): one method, the op is in the params. */
  'ceo',
  /** Lean Team v3: facts the server knows (environment, dependencies, branch, stage, blockers), so no question is spent on them (`aom card facts`). */
  'card.facts',
  /** Lean Team v3: record a dependency between open cards of a project, add only (`aom block --on dependency <ref>`). */
  'card.depend',
  /** Lean Team v3: has the question of this shift been answered yet (`aom question --wait` polls it). */
  'question.status',
  /** The tester's environment (#59): `aom env info|logs|restart|suites`, answered by the runner (suites: by the server). */
  'env.info',
  'env.logs',
  'env.restart',
  'env.suites',
  'env.suites.propose',
  /** `aom test suite`: the runner parses the report, attaches the log and sends the result to the server. */
  'test.suite',
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
