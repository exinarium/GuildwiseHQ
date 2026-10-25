import { z } from 'zod';
import { AccountKeySchema } from '../claude/accounts.ts';
import { defineEvent, Id, Stage, Usage } from './define.ts';

export const ShiftKind = z.enum(['card', 'chat', 'question', 'devops', 'ba_task', 'ceo']);
export type ShiftKind = z.infer<typeof ShiftKind>;

export const ShiftEndOutcome = z.enum([
  'reported',
  'no_report',
  'stopped',
  'crashed',
  'timeout',
  'rejected',
  'lost',
]);
export type ShiftEndOutcome = z.infer<typeof ShiftEndOutcome>;

export const GuardViolation = z.object({ rule: z.string(), detail: z.string() });
export type GuardViolation = z.infer<typeof GuardViolation>;

export const shiftEvents = [
  defineEvent(
    'ShiftStarted',
    z.object({
      shiftId: Id,
      agentId: Id,
      workstationId: Id,
      cardId: Id.optional(),
      kind: ShiftKind,
      stage: Stage.optional(),
      runtime: z.string(),
      model: z.string(),
      overflow: z.boolean().default(false),
      /** R3c (Q64): the person whose message started this agent chat; what an agent starts in the chat belongs to them. */
      chatUserId: Id.optional(),
      /** Chats about a project without a card: the shift's project (card shifts resolve it through the card). */
      projectId: Id.optional(),
      runtimeSessionId: z.string().optional(),
      /** A chat about a project's card: the account the project chose for it (absent: the main account). */
      accountKey: AccountKeySchema.optional(),
      /** A CEO chat turn: `owner` (the Owner's message) or `order` (an Owner-authorized standing order); absent otherwise. */
      mode: z.enum(['owner', 'order']).optional(),
      /** Additive: set from the runner's `shift.started`; the server learns the worktree path here. */
      worktree: z
        .object({
          path: z.string(),
          branchName: z.string(),
          baseBranch: z.string(),
          created: z.boolean(),
          headSha: z.string(),
          rebased: z.boolean().optional(),
        })
        .optional(),
    }),
  ),
  /**
   * The runner reported the usage of a shift the server had already ended without it (crashed, lost, timed out): the
   * tokens and the price are filled in afterwards. Recorded once, only when the shift was priced at zero.
   */
  defineEvent(
    'ShiftUsageRecorded',
    z.object({
      shiftId: Id,
      usage: Usage,
      /** USD micro-units stamped by the server when it prices the usage; absent: the default table prices it. */
      costMicros: z.number().int().nonnegative().optional(),
    }),
  ),
  /** The runner learned Claude's session id after `shift.started`, or re-measured the session's context size. */
  defineEvent(
    'ShiftSessionRecorded',
    z.object({
      shiftId: Id,
      runtimeSessionId: z.string().optional(),
      /** The session's context size: the last call's input + cache read + cache write tokens. */
      contextTokens: z.number().int().nonnegative().optional(),
      /** What the runner did with a resume request: `resumed` or `fresh_<why>`. */
      resumeState: z.string().max(60).optional(),
    }),
  ),
  defineEvent(
    'ShiftEnded',
    z.object({
      shiftId: Id,
      agentId: Id,
      cardId: Id.optional(),
      outcome: ShiftEndOutcome,
      reportOutcome: z.string().optional(),
      durationMs: z.number().int().nonnegative(),
      usage: Usage,
      /** USD micro-units stamped by the server when it prices the shift; absent: the default table prices it. */
      costMicros: z.number().int().nonnegative().optional(),
      exitCode: z.number().int().nullable().optional(),
      guardViolations: z.array(GuardViolation).default([]),
      /** Outcome `rejected`: why the runner turned the shift away (`reason: detail`). */
      rejectionReason: z.string().max(600).optional(),
    }),
  ),
] as const;
