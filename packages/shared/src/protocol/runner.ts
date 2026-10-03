import { z } from 'zod';
import { DiffStats } from '../cards/types.ts';
import { Usage } from '../events/define.ts';
import { GuardViolation, ShiftKind } from '../events/shift.ts';
import { PROTOCOL_VERSION, uuidv7 } from '../ids.ts';
import { AgentPermissionsSchema, Seniority } from '../roles/schema.ts';
import { LedgerMatchSchema, RpcMethodSchema, ShiftReportSchema } from './ipc.ts';

/**
 * Runner WebSocket protocol (docs/ARCHITECTURE.md section 11.2).
 * Endpoint `wss://<host>/api/runner/ws`, header `Authorization: Bearer aomr_...`, subprotocol `aom.runner.v1`.
 * Every frame is a JSON text envelope `{ v:1, id, type, ts, ...payload }` with the payload fields inline.
 */

export const RUNNER_SUBPROTOCOL = 'aom.runner.v1';
export const RUNNER_TOKEN_PREFIX = 'aomr_';
export const WS_CLOSE = { unauthorized: 4401, forbidden: 4403, superseded: 4409 } as const;
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

export const RuntimeInfoSchema = z.object({
  id: z.string(),
  version: z.string(),
  available: z.boolean(),
  capabilities: z.array(z.string()),
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
    domain: z.enum(['work', 'personal']),
    workingBranch: z.string(),
    e2eGlobs: z.array(z.string()),
    architecturalGlobs: z.array(z.string()),
    vaultFolder: z.string().optional(),
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
});
export type ShiftBrief = z.infer<typeof ShiftBriefSchema>;

export const ChatContextSchema = z.object({
  projectId: z.uuid().optional(),
  cardId: z.uuid().optional(),
  projectKey: z.string().optional(),
  cardRef: z.string().optional(),
});
export type ChatContext = z.infer<typeof ChatContextSchema>;

export const RunnerCommandNameSchema = z.enum([
  'agent.wipe',
  'worktree.remove',
  'repos.rescan',
  'vault.configure',
  'vault.write',
  'finalize.execute',
  'outbound.post',
]);
export type RunnerCommandName = z.infer<typeof RunnerCommandNameSchema>;

/** Typed payloads for the M1 commands; later commands add theirs. `command.payload` is the loose record on the wire. */
export const CommandPayloadSchemas = {
  'agent.wipe': z.object({ agentId: z.uuid() }),
  'worktree.remove': z.object({
    repoId: z.uuid().optional(),
    path: z.string(),
    branchName: z.string().optional(),
    deleteBranch: z.boolean().default(false),
  }),
  'repos.rescan': z.object({}),
} as const;

export const ShiftRejectReasonSchema = z.enum([
  'busy',
  'runtime_unavailable',
  'repo_missing',
  'worktree_failed',
  'rebase_conflict',
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
});
export const OutboxFlushedSchema = msg('outbox.flushed', {});
export const HeartbeatSchema = msg('heartbeat', {
  activeShifts: z.array(z.string()),
  load: z.object({ runningShifts: z.number().int().nonnegative() }),
});
export const ReposReportSchema = msg('repos.report', { repos: z.array(RepoReportSchema) });
export const ShiftAcceptedSchema = msg('shift.accepted', { shiftId: z.uuid() });
export const ShiftRejectedSchema = msg('shift.rejected', {
  shiftId: z.uuid(),
  reason: ShiftRejectReasonSchema,
  detail: z.string().optional(),
  conflictedFiles: z.array(z.string()).optional(),
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
  kind: z.enum(['card', 'question', 'devops']),
  agent: AgentRuntimeSpecSchema,
  brief: ShiftBriefSchema,
  worktree: WorktreeSpecSchema.nullable(),
  prepare: z.object({ rebase: z.boolean() }),
  maxShiftMinutes: z.number().int().positive(),
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
  ShiftAcceptedSchema,
  ShiftRejectedSchema,
  ShiftStartedSchema,
  ShiftProgressSchema,
  ShiftReportMsgSchema,
  ShiftEndedSchema,
  RpcRequestSchema,
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
