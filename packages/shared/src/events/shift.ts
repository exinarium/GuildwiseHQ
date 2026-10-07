import { z } from 'zod';
import { defineEvent, Id, Stage, Usage } from './define.ts';

export const ShiftKind = z.enum(['card', 'chat', 'question', 'devops', 'ba_task']);
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
      /** Chats about a project without a card: the shift's project (card shifts resolve it through the card). */
      projectId: Id.optional(),
      runtimeSessionId: z.string().optional(),
      /** Additive: set from the runner's `shift.started`; the server learns the worktree path here. */
      worktree: z
        .object({
          path: z.string(),
          branchName: z.string(),
          baseBranch: z.string(),
          created: z.boolean(),
          headSha: z.string(),
        })
        .optional(),
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
    }),
  ),
] as const;
