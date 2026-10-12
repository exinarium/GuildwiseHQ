import { z } from 'zod';
import { DiffStats } from '../cards/types.ts';
import {
  EnvEnsurePayloadSchema,
  RepoClonePayloadSchema,
  RightsVerifyPayloadSchema,
  SudoKeySchema,
  SudoSetPayloadSchema,
} from '../devops/environment.ts';
import { DevopsShiftSchema } from '../devops/index.ts';
import { Usage } from '../events/define.ts';
import { GuardViolation, ShiftKind } from '../events/shift.ts';
import { TestEnvProblem } from '../events/testing.ts';
import { VaultEventKind } from '../events/vault.ts';
import { OutboundPostPayloadSchema } from '../external/index.ts';
import { FeedItemInputSchema } from '../feed/index.ts';
import {
  ForgeKindSchema,
  ForgeReposPayloadSchema,
  GitConnectionsSchema,
  GitSshPayloadSchema,
  RepoAccessPayloadSchema,
} from '../forge/index.ts';
import { SWEEP_QUERY_MAX_PATHS, WorktreesSweepPayloadSchema } from '../hygiene/index.ts';
import { PROTOCOL_VERSION, uuidv7 } from '../ids.ts';
import { IntakeContextSchema, QuestionShiftSchema } from '../intake/index.ts';
import { BaTaskShiftSchema, BranchCheckMergedPayloadSchema } from '../phases/index.ts';
import { RepoCreatePayloadSchema } from '../repo/index.ts';
import { AgentPermissionsSchema, Seniority } from '../roles/schema.ts';
import { VaultFolderSchema } from '../safe.ts';
import { FinalizeExecutePayloadSchema } from '../testing/index.ts';
import {
  VaultConfigureCommandSchema,
  VaultIdSchema,
  VaultMergeCommandSchema,
  VaultMoveCommandSchema,
  VaultWriteCommandSchema,
} from '../vaults/index.ts';
import { LedgerMatchSchema, RpcMethodSchema, ShiftReportSchema } from './ipc.ts';

/**
 * Runner WebSocket protocol (docs/ARCHITECTURE.md section 11.2).
 * Endpoint `wss://<host>/api/runner/ws`, header `Authorization: Bearer aomr_...`, subprotocol `aom.runner.v1`.
 * Every frame is a JSON text envelope `{ v:1, id, type, ts, ...payload }` with the payload fields inline.
 */

export const RUNNER_SUBPROTOCOL = 'aom.runner.v1';
export const RUNNER_TOKEN_PREFIX = 'aomr_';
export const WS_CLOSE = { unauthorized: 4401, forbidden: 4403, superseded: 4409 } as const;
/** The close reason of a 4403 sent because the workstation was unpaired in the web app: the runner then stops cleanly. */
export const UNPAIRED_CLOSE_REASON = 'workstation unpaired';
export const HEARTBEAT_SEC = 15;

const msg = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().min(1),
    type: z.literal(type),
    ts: z.iso.datetime(),
    ...shape,
  });

// ---------------------------------------------------------------- shared shapes

/**
 * Is an OS-level boundary around the agent's shell in force? `enforced`: yes. `unsandboxed`: no, and the owner opted
 * in (config `off`, or `best_effort` + `allowUnsandboxed`). `unavailable`: no, and the runtime refuses to run agents.
 */
export const SandboxStateSchema = z.enum(['enforced', 'unsandboxed', 'unavailable']);
export type SandboxState = z.infer<typeof SandboxStateSchema>;

export const RuntimeInfoSchema = z.object({
  id: z.string(),
  version: z.string(),
  available: z.boolean(),
  capabilities: z.array(z.string()),
  /** Absent from older runners and from runtimes without a sandbox concept: no warning is shown then. */
  sandbox: SandboxStateSchema.optional(),
  sandboxReason: z.string().optional(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

export const RepoReportSchema = z.object({
  remoteUrl: z.string(),
  localPath: z.string(),
  headBranch: z.string().nullable(),
});
export type RepoReport = z.infer<typeof RepoReportSchema>;

export const AgentRuntimeSpecSchema = z.object({
  agentId: z.uuid(),
  name: z.string(),
  roleKey: z.string(),
  seniority: Seniority,
  runtime: z.string(),
  model: z.string(),
  effort: z.string().optional(),
  skills: z.array(z.string()),
  permissions: AgentPermissionsSchema,
  isDevops: z.boolean(),
});
export type AgentRuntimeSpec = z.infer<typeof AgentRuntimeSpecSchema>;

export const WorktreeSpecSchema = z.object({
  mode: z.enum(['create', 'reuse']),
  repoId: z.uuid(),
  remoteUrlNormalized: z.string(),
  baseBranch: z.string(),
  branchName: z.string(),
  /** Set for `reuse`. */
  path: z.string().optional(),
  /** The repository's main branch: a missing working branch is created from it (absent: the default branch). */
  mainBranch: z.string().optional(),
});
export type WorktreeSpec = z.infer<typeof WorktreeSpecSchema>;

export const ShiftBriefSchema = z.object({
  shift: z.object({
    id: z.uuid(),
    kind: ShiftKind,
    stage: z.string(),
    stageLabel: z.string(),
    doneCriteria: z.string(),
    outcomes: z.array(
      z.object({ id: z.string(), label: z.string(), kind: z.enum(['success', 'failure']), data: z.string() }),
    ),
    maxShiftMinutes: z.number().int().positive(),
  }),
  /** Contract addition: who is being briefed (the instructions open with this). */
  agent: z.object({ id: z.uuid(), name: z.string(), seniority: Seniority }),
  card: z.object({
    id: z.uuid(),
    ref: z.string(),
    title: z.string(),
    cardType: z.string(),
    fields: z.record(z.string(), z.unknown()),
    riskTier: z.enum(['small', 'large']).nullable(),
    reworkRound: z.number().int().nonnegative(),
    completionAction: z.enum(['pr', 'push_branch', 'merge']).nullable(),
    docsNeeded: z.boolean(),
    dependencies: z.array(z.object({ ref: z.string(), title: z.string(), status: z.string() })),
    parent: z.object({ ref: z.string(), title: z.string() }).optional(),
  }),
  project: z.object({
    id: z.uuid(),
    key: z.string(),
    name: z.string(),
    /** Legacy (ignored): the server no longer sends it. */
    domain: z.enum(['work', 'personal']).optional(),
    workingBranch: z.string(),
    e2eGlobs: z.array(z.string()),
    architecturalGlobs: z.array(z.string()),
    vaultFolder: z.string().optional(),
    /** The sub directory of the card's repository the project lives in; absent: the repository root. */
    projectPath: z.string().optional(),
    /** M3: `PROJECT.md` from the card's vault, filled in by the runner (the site holds no vault content). */
    projectDoc: z.string().optional(),
  }),
  role: z.object({
    key: z.string(),
    name: z.string(),
    instructions: z.string(),
    coreRules: z.array(z.string()),
    extensions: z.string().optional(),
    skills: z.array(z.string()),
  }),
  /** All handoffs, oldest first. */
  handoffs: z.array(
    z.object({
      stage: z.string(),
      agentName: z.string(),
      outcome: z.string(),
      note: z.string(),
      at: z.iso.datetime(),
    }),
  ),
  /** Latest rework round. */
  reviewComments: z.array(
    z.object({
      reviewerName: z.string(),
      reasons: z.array(z.string()),
      criteriaMissed: z.array(z.string()),
      comments: z.string(),
      at: z.iso.datetime(),
    }),
  ),
  /** Last 30 thread messages. */
  thread: z.array(
    z.object({ authorName: z.string(), kind: z.string(), body: z.string(), at: z.iso.datetime() }),
  ),
  /** Ledger standing orders (M2), org + project. */
  standingOrders: z.array(z.object({ title: z.string(), body: z.string() })).default([]),
  /** Ledger entries linked to the card. */
  ledger: z
    .array(z.object({ id: z.string(), scope: z.string(), title: z.string(), body: z.string() }))
    .default([]),
  /**
   * M5: feed context for scouts and curators. `candidates` are the items the scout handed off (curator only),
   * `seenUrls` the project's seen-list (normalized), `taste` the project's `taste.md` (filled in by the runner from
   * the vault).
   */
  feed: z
    .object({
      candidates: z.array(FeedItemInputSchema).default([]),
      seenUrls: z.array(z.string()).default([]),
      taste: z.string().optional(),
      /** Explicit taste rules the manager set on the Interests page (project-wide plus this card's interest). */
      tasteSeed: z.array(z.string()).default([]),
    })
    .optional(),
});
export type ShiftBrief = z.infer<typeof ShiftBriefSchema>;

/**
 * A repository an agent may read (read-only) on this workstation, named by its remote: the runner resolves it to the
 * local clone. `project`: a repository of the chat's own project; `reference`: one of the project's reference repositories.
 */
export const ReadRepoSchema = z.object({
  repoId: z.uuid(),
  name: z.string(),
  remoteUrlNormalized: z.string(),
  kind: z.enum(['project', 'reference']),
});
export type ReadRepo = z.infer<typeof ReadRepoSchema>;

export const ChatContextSchema = z.object({
  projectId: z.uuid().optional(),
  cardId: z.uuid().optional(),
  projectKey: z.string().optional(),
  cardRef: z.string().optional(),
  /** Where the card's worktree lives on its home workstation (read-only context for the chat). */
  cardWorktreePath: z.string().optional(),
  /** Repositories the chat may read here: the project's own and its reference repositories (absent: none). */
  readRepos: z.array(ReadRepoSchema).optional(),
  /** M7: set for the BA's intake chat (project list, mapping state, cards created so far). */
  intake: IntakeContextSchema.optional(),
});
export type ChatContext = z.infer<typeof ChatContextSchema>;

/**
 * `integration.run`: poll GitHub or Jira on the owner's workstation (the credentials never leave it). The answer is the
 * issues that match; the server takes the new ones into intake (docs/ARCHITECTURE.md section 10.4).
 */
export const IntegrationRunPayloadSchema = z.object({
  scheduleId: z.uuid(),
  /** The run waiting for the answer (an `issues_poll` action); absent for a labelled-issue trigger. */
  runId: z.uuid().optional(),
  integration: z.enum(['github', 'jira']),
  /** GitHub: `owner/repo`. Jira: a JQL filter. */
  query: z.string().min(1).max(500),
  /** Only issues with this label (a labelled-issue trigger). */
  label: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export type IntegrationRunPayload = z.infer<typeof IntegrationRunPayloadSchema>;

export const PolledIssueSchema = z.object({
  key: z.string().min(1).max(300),
  title: z.string().max(500),
  url: z.string().max(2000).optional(),
  body: z.string().max(20000).default(''),
  labels: z.array(z.string()).default([]),
});
export type PolledIssue = z.infer<typeof PolledIssueSchema>;

export const IntegrationRunResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(2000).optional(),
  issues: z.array(PolledIssueSchema).default([]),
});
export type IntegrationRunResult = z.infer<typeof IntegrationRunResultSchema>;

/**
 * `repo.open_pr`: open a pull request from a repository's working branch to its main branch (the project settings
 * button). `base` is the main branch the owner named; absent: the repository's default branch.
 */
export const RepoOpenPrPayloadSchema = z.object({
  requestId: z.uuid(),
  projectId: z.uuid(),
  repoId: z.uuid(),
  remoteUrlNormalized: z.string(),
  /** The working branch (the head of the pull request). */
  head: z.string().min(1),
  base: z.string().min(1).optional(),
  title: z.string().max(300),
  body: z.string().max(5000),
  forge: ForgeKindSchema.optional(),
});
export type RepoOpenPrPayload = z.infer<typeof RepoOpenPrPayloadSchema>;

export const RepoOpenPrResultSchema = z.object({
  ok: z.boolean(),
  /** The main branch the pull request goes to, as resolved on the workstation. */
  base: z.string().optional(),
  url: z.string().optional(),
  /** `ok` and no pull request: the working branch has nothing the main branch lacks, or it is the main branch. */
  nothingToDo: z.boolean().optional(),
  notice: z.string().optional(),
  error: z.string().optional(),
});
export type RepoOpenPrResult = z.infer<typeof RepoOpenPrResultSchema>;

export const RunnerCommandNameSchema = z.enum([
  'agent.wipe',
  'worktree.remove',
  'repos.rescan',
  'vault.configure',
  'vault.write',
  'vault.move',
  'vault.merge',
  'finalize.execute',
  'outbound.post',
  'repo.create',
  'branch.check_merged',
  'worktrees.sweep',
  'integration.run',
  'repo.clone',
  'env.ensure',
  'rights.verify',
  'sudo.set',
  'sudo.clear',
  'git.status',
  'forge.repos',
  'git.ssh',
  'repo.access',
  'repo.open_pr',
]);
export type RunnerCommandName = z.infer<typeof RunnerCommandNameSchema>;

/** The one vault a card shift may read (docs/ARCHITECTURE.md section 16.1): its project vault, or the organization vault. */
export const ShiftVaultSchema = z.object({
  vaultId: VaultIdSchema,
  kind: VaultEventKind,
  /** `projects/<name>` inside the vault. */
  folder: VaultFolderSchema,
});
export type ShiftVault = z.infer<typeof ShiftVaultSchema>;

/** Typed payloads for the commands; `command.payload` is the loose record on the wire. */
export const CommandPayloadSchemas = {
  'vault.configure': VaultConfigureCommandSchema,
  'vault.write': VaultWriteCommandSchema,
  'vault.move': VaultMoveCommandSchema,
  'vault.merge': VaultMergeCommandSchema,
  'agent.wipe': z.object({ agentId: z.uuid() }),
  'worktree.remove': z.object({
    repoId: z.uuid().optional(),
    path: z.string(),
    branchName: z.string().optional(),
    deleteBranch: z.boolean().default(false),
  }),
  'repos.rescan': z.object({}),
  'finalize.execute': FinalizeExecutePayloadSchema,
  'outbound.post': OutboundPostPayloadSchema,
  'repo.create': RepoCreatePayloadSchema,
  'branch.check_merged': BranchCheckMergedPayloadSchema,
  'worktrees.sweep': WorktreesSweepPayloadSchema,
  'integration.run': IntegrationRunPayloadSchema,
  'repo.clone': RepoClonePayloadSchema,
  'env.ensure': EnvEnsurePayloadSchema,
  'rights.verify': RightsVerifyPayloadSchema,
  'sudo.set': SudoSetPayloadSchema,
  'sudo.clear': z.object({}),
  'git.status': z.object({}),
  'forge.repos': ForgeReposPayloadSchema,
  'git.ssh': GitSshPayloadSchema,
  'repo.access': RepoAccessPayloadSchema,
  'repo.open_pr': RepoOpenPrPayloadSchema,
} as const;

export const ShiftRejectReasonSchema = z.enum([
  'busy',
  'runtime_unavailable',
  'repo_missing',
  'worktree_failed',
  'rebase_conflict',
  /** M4: a tester shift found the app not deployed or Docker missing (see `environment`). */
  'environment_not_ready',
  'internal',
]);
export const ShiftStopReasonSchema = z.enum([
  'timeout',
  'claim_lost',
  'agent_retired',
  'manager',
  'card_cancelled',
]);
export const ProgressItemSchema = z.object({
  at: z.iso.datetime(),
  kind: z.enum(['text', 'tool', 'status']),
  text: z.string().max(500),
});
export type ProgressItem = z.infer<typeof ProgressItemSchema>;
export const RunnerShiftOutcomeSchema = z.enum(['reported', 'no_report', 'stopped', 'crashed', 'timeout']);

// ----------------------------------------------------------------- runner -> server

export const HelloSchema = msg('hello', {
  runnerVersion: z.string(),
  protocol: z.literal(PROTOCOL_VERSION),
  platform: z.string(),
  hostname: z.string(),
  runtimes: z.array(RuntimeInfoSchema),
  repos: z.array(RepoReportSchema),
  vaults: z.array(z.object({ vaultId: z.string(), localPath: z.string(), clean: z.boolean() })).default([]),
  activeShifts: z.array(
    z.object({
      shiftId: z.uuid(),
      cardId: z.uuid().optional(),
      agentId: z.uuid(),
      startedAt: z.iso.datetime(),
    }),
  ),
  outboxPending: z.number().int().nonnegative(),
  /** The runner's configured `maxConcurrentShifts` (shown on the Workstations page; the server caps it). */
  maxConcurrentShifts: z.number().int().positive().optional(),
  /** The key the manager's browser encrypts the sudo password with (the private half never leaves the runner). */
  sudoKey: SudoKeySchema.optional(),
});
export const OutboxFlushedSchema = msg('outbox.flushed', {});
export const HeartbeatSchema = msg('heartbeat', {
  activeShifts: z.array(z.string()),
  load: z.object({ runningShifts: z.number().int().nonnegative() }),
});
/** The runtimes' probe result changed (sandbox state, availability): sent after a re-probe, not only in `hello`. */
export const RuntimesReportSchema = msg('runtimes.report', { runtimes: z.array(RuntimeInfoSchema) });
/**
 * Which git providers this workstation is connected to (facts only, never a token). Sent after `hello`, after
 * `aom-runner git-connect` and on the `git.status` command.
 */
export const GitReportSchema = msg('git.report', { connections: GitConnectionsSchema });
/** How a runner's self-update stands (docs/RUNNER.md "Updates"). */
export const RUNNER_UPDATE_STATES = [
  'up_to_date',
  'pending',
  'updating',
  'failed',
  'rolled_back',
  'paused',
  'unmanaged',
] as const;
export const RunnerUpdateStateSchema = z.enum(RUNNER_UPDATE_STATES);
export type RunnerUpdateState = z.infer<typeof RunnerUpdateStateSchema>;
/**
 * The runner's update state, sent after `welcome` and whenever it changes: `pending` a newer version is downloaded and
 * waits for the runner to be idle, `updating` it is switching and restarting, `failed` the last attempt failed,
 * `rolled_back` a new version did not connect and the previous one was restored, `paused` a super admin paused
 * auto-updates, `unmanaged` this install cannot update itself (started by hand, not from the installer's layout).
 */
export const RunnerUpdateReportSchema = msg('runner.update', {
  state: RunnerUpdateStateSchema,
  latestVersion: z.string().max(40).nullable(),
  lastCheckedAt: z.iso.datetime().nullable(),
  detail: z.string().max(300).nullable(),
});
export const ReposReportSchema = msg('repos.report', { repos: z.array(RepoReportSchema) });
export const ShiftAcceptedSchema = msg('shift.accepted', { shiftId: z.uuid() });
export const ShiftRejectedSchema = msg('shift.rejected', {
  shiftId: z.uuid(),
  reason: ShiftRejectReasonSchema,
  detail: z.string().optional(),
  conflictedFiles: z.array(z.string()).optional(),
  /** Set with `reason: 'environment_not_ready'`. */
  environment: z.object({ problem: TestEnvProblem, detail: z.string().optional() }).optional(),
  /** Set with `reason: 'worktree_failed'` when the card's base (working) branch does not exist in the clone. */
  branchProblem: z
    .object({
      base: z.string(),
      /** `origin/HEAD` of the clone, or its only branch. */
      defaultBranch: z.string().optional(),
      branches: z.array(z.string()).max(200),
      /** Why creating the branch from the default branch did not work (the runner tries first). */
      createFailed: z.string().max(500).optional(),
    })
    .optional(),
});
export const ShiftStartedSchema = msg('shift.started', {
  shiftId: z.uuid(),
  runtimeSessionId: z.string().optional(),
  worktree: z
    .object({
      path: z.string(),
      branchName: z.string(),
      baseBranch: z.string(),
      created: z.boolean(),
      headSha: z.string(),
    })
    .optional(),
  /** The working branch did not exist: the runner created it from `from` (the default branch) and pushed it. */
  branchCreated: z.object({ base: z.string(), from: z.string(), pushed: z.boolean() }).optional(),
});
export const ShiftProgressSchema = msg('shift.progress', {
  shiftId: z.uuid(),
  items: z.array(ProgressItemSchema),
});
/** `report` for a terminal outcome from a build stage also carries runner-attached `diffStats` and `riskTier`. */
export const ShiftReportMsgSchema = msg('shift.report', {
  shiftId: z.uuid(),
  reportId: z.uuid(),
  report: ShiftReportSchema,
  diffStats: DiffStats.optional(),
  riskTier: z.enum(['small', 'large']).optional(),
});
export const ShiftEndedSchema = msg('shift.ended', {
  shiftId: z.uuid(),
  outcome: RunnerShiftOutcomeSchema,
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative(),
  usage: Usage,
  finalText: z.string().max(4000).optional(),
  guardViolations: z.array(GuardViolation).default([]),
});
export const RpcRequestSchema = msg('rpc.request', {
  rpcId: z.string().min(1),
  shiftId: z.uuid(),
  method: RpcMethodSchema,
  params: z.record(z.string(), z.unknown()),
});
/**
 * The runner's sweep of stale worktrees (start-up and the hygiene job) asks which of the card worktrees it found are
 * still in use. Answered by `worktrees.live`; a runner that gets no answer sweeps nothing.
 */
export const WorktreesQuerySchema = msg('worktrees.query', {
  queryId: z.string().min(1),
  paths: z.array(z.string()).max(SWEEP_QUERY_MAX_PATHS),
});
export const ChatDeltaSchema = msg('chat.delta', {
  chatId: z.string(),
  threadId: z.uuid(),
  text: z.string(),
});
export const ChatDoneSchema = msg('chat.done', {
  chatId: z.string(),
  threadId: z.uuid(),
  messageText: z.string(),
  usage: Usage,
  /** Runtime session to `--resume` on the next message of this conversation. */
  runtimeSessionId: z.string().optional(),
});
export const ChatErrorSchema = msg('chat.error', {
  chatId: z.string(),
  threadId: z.uuid(),
  error: z.string(),
});
export const CommandResultSchema = msg('command.result', {
  commandId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
/** Asks the server for a new runner token (`aom-runner rotate-token`); the old one stays valid until the new one connects. */
export const TokenRotateSchema = msg('token.rotate', {});
export const VaultStatusSchema = msg('vault.status', {
  vaultId: z.string(),
  lastPullAt: z.iso.datetime().nullable(),
  lastPushAt: z.iso.datetime().nullable(),
  error: z.string().optional(),
  /** Additive: where the clone lives on the workstation (also reported by `hello.vaults`). */
  localPath: z.string().optional(),
});
export const VaultConflictSchema = msg('vault.conflict', { vaultId: z.string(), files: z.array(z.string()) });

// ----------------------------------------------------------------- server -> runner

export const WelcomeSchema = msg('welcome', {
  workstationId: z.uuid(),
  serverTime: z.iso.datetime(),
  heartbeatSec: z.number().int().positive().default(HEARTBEAT_SEC),
  limits: z.object({ maxConcurrentShifts: z.number().int().positive() }),
});
export const ShiftStartSchema = msg('shift.start', {
  shiftId: z.uuid(),
  claimId: z.uuid(),
  kind: z.enum(['card', 'question', 'devops', 'ba_task']),
  agent: AgentRuntimeSpecSchema,
  brief: ShiftBriefSchema,
  worktree: WorktreeSpecSchema.nullable(),
  prepare: z.object({ rebase: z.boolean() }),
  maxShiftMinutes: z.number().int().positive(),
  /** M3: for `kind: 'devops'` the request being worked (the brief then carries a placeholder card). */
  devops: DevopsShiftSchema.optional(),
  /** M7: for `kind: 'question'` the desk item to answer or escalate (the brief then carries the card in question). */
  question: QuestionShiftSchema.optional(),
  /** Phases: for `kind: 'ba_task'` the background task (phase report, follow-up briefs, ...); the brief carries a placeholder card. */
  baTask: BaTaskShiftSchema.optional(),
  /** M3: the card's vault (its project vault or the organization vault); the runner reads only this vault and passes only it as `--add-dir`. */
  vault: ShiftVaultSchema.nullable().optional(),
  /** The project's reference repositories: read-only for this shift when the workstation has a clone. */
  readRepos: z.array(ReadRepoSchema).optional(),
});
export const ShiftStopSchema = msg('shift.stop', { shiftId: z.uuid(), reason: ShiftStopReasonSchema });
export const ShiftReportResultSchema = msg('shift.report.result', {
  reportId: z.uuid(),
  accepted: z.boolean(),
  error: z.string().optional(),
  /** Shown to the agent on acceptance (e.g. what happened to its question). */
  message: z.string().optional(),
  /** Ledger entries that matched a question (duplicate check). */
  matches: z.array(LedgerMatchSchema).optional(),
});
export const RpcResponseSchema = msg('rpc.response', {
  rpcId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
/** The subset of `worktrees.query.paths` that belongs to a live card (not finalized, cancelled or unknown). */
export const WorktreesLiveSchema = msg('worktrees.live', {
  queryId: z.string(),
  live: z.array(z.string()),
});
export const ChatStartSchema = msg('chat.start', {
  chatId: z.string(),
  threadId: z.uuid(),
  agent: AgentRuntimeSpecSchema,
  message: z.string(),
  resumeSessionId: z.string().optional(),
  context: ChatContextSchema,
});
export const TokenRotatedSchema = msg('token.rotated', { token: z.string().min(1) });
export const ChatCancelSchema = msg('chat.cancel', { chatId: z.string() });
export const CommandSchema = msg('command', {
  commandId: z.string(),
  command: RunnerCommandNameSchema,
  payload: z.record(z.string(), z.unknown()),
});
/** Either direction. */
export const AckSchema = msg('ack', { ackOf: z.string().min(1) });

export const RunnerToServerSchema = z.discriminatedUnion('type', [
  HelloSchema,
  OutboxFlushedSchema,
  HeartbeatSchema,
  ReposReportSchema,
  RuntimesReportSchema,
  GitReportSchema,
  RunnerUpdateReportSchema,
  ShiftAcceptedSchema,
  ShiftRejectedSchema,
  ShiftStartedSchema,
  ShiftProgressSchema,
  ShiftReportMsgSchema,
  ShiftEndedSchema,
  RpcRequestSchema,
  WorktreesQuerySchema,
  ChatDeltaSchema,
  ChatDoneSchema,
  ChatErrorSchema,
  CommandResultSchema,
  VaultStatusSchema,
  VaultConflictSchema,
  TokenRotateSchema,
  AckSchema,
]);
export type RunnerToServer = z.infer<typeof RunnerToServerSchema>;

export const ServerToRunnerSchema = z.discriminatedUnion('type', [
  WelcomeSchema,
  ShiftStartSchema,
  ShiftStopSchema,
  ShiftReportResultSchema,
  RpcResponseSchema,
  WorktreesLiveSchema,
  ChatStartSchema,
  ChatCancelSchema,
  CommandSchema,
  TokenRotatedSchema,
  AckSchema,
]);
export type ServerToRunner = z.infer<typeof ServerToRunnerSchema>;

export type RunnerToServerType = RunnerToServer['type'];
export type ServerToRunnerType = ServerToRunner['type'];
export type RunnerToServerOf<T extends RunnerToServerType> = Extract<RunnerToServer, { type: T }>;
export type ServerToRunnerOf<T extends ServerToRunnerType> = Extract<ServerToRunner, { type: T }>;

/** Messages the receiver must `ack` (sender persists/retries until acked). `hello` is answered by `welcome`. */
export const RUNNER_ACKED_TYPES: ReadonlySet<string> = new Set<RunnerToServerType>([
  'shift.accepted',
  'shift.rejected',
  'shift.started',
  'shift.report',
  'shift.ended',
  'chat.done',
  'chat.error',
  'command.result',
  'vault.conflict',
]);
export const SERVER_ACKED_TYPES: ReadonlySet<string> = new Set<ServerToRunnerType>(['shift.stop']);

export const isAckedFromRunner = (type: string): boolean => RUNNER_ACKED_TYPES.has(type);
export const isAckedFromServer = (type: string): boolean => SERVER_ACKED_TYPES.has(type);

/** Builds an envelope: `{ v, id (uuid v7), type, ts, ...payload }`. Validate with the schemas above. */
export function makeEnvelope<T extends string, P extends Record<string, unknown>>(
  type: T,
  payload: P,
  now: Date = new Date(),
  id: string = uuidv7(),
): { v: typeof PROTOCOL_VERSION; id: string; type: T; ts: string } & P {
  return { v: PROTOCOL_VERSION, id, type, ts: now.toISOString(), ...payload };
}
