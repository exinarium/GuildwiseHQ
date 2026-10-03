import { z } from 'zod';
import { defineEvent, Id, Stage, Usage } from './define.ts';

export const ShiftKind = z.enum(['card', 'chat', 'question', 'devops']);
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
      runtimeSessionId: z.string().optional(),
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
      exitCode: z.number().int().nullable().optional(),
      guardViolations: z.array(GuardViolation).default([]),
    }),
  ),
] as const;
