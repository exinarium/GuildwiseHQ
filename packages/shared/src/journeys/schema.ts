import { z } from 'zod';

export const RECORD_TYPES = ['client', 'matter', 'deal'] as const;
export const JourneyRecordTypeSchema = z.enum(RECORD_TYPES);
export type JourneyRecordType = z.infer<typeof JourneyRecordTypeSchema>;

import { Position, StepIdSchema } from './step-base.ts';
import {
  JourneyGateStepSchema,
  JourneyWaitStepSchema,
  JourneyWebhookCallStepSchema,
  type JourneyGateStep,
  type JourneyWaitStep,
  type JourneyWebhookCallStep,
} from './steps-wait.ts';

export { Position, StepIdSchema };

export const JourneyConditionSchema = z.object({
  /** `card`: a field of the card the step just ended with (column first, then card.fields). `record`: type | status | visits. */
  source: z.enum(['card', 'record']),
  field: z.string().min(1).max(100),
  op: z.enum(['equals', 'not_equals', 'is_set', 'is_not_set', 'lt', 'gte']),
  value: z.union([z.string().max(200), z.number(), z.boolean()]).optional(),
});
export type JourneyCondition = z.infer<typeof JourneyConditionSchema>;


export const WorkflowStepSchema = z.object({
  kind: z.literal('workflow'),
  id: StepIdSchema,
  label: z.string().min(1).max(120),
  /** null in a template until the user picks one. */
  workflowKey: z.string().min(1).nullable(),
  cardType: z.string().optional(),
  /** Card title and field text from the record: `{record.name}`, `{record.type}`, `{record.externalId}`, `{step.label}`. */
  fieldsIn: z
    .array(z.object({ to: z.string().min(1), template: z.string().max(500) }))
    .max(20)
    .default([]),
  playbook: z.object({ key: z.string().min(1).max(130), name: z.string().max(200) }).optional(),
  position: Position.optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

export const JourneyStepSchema = z.discriminatedUnion('kind', [
  WorkflowStepSchema,
  JourneyWaitStepSchema,
  JourneyGateStepSchema,
  JourneyWebhookCallStepSchema,
]);
export type JourneyStep = WorkflowStep | JourneyWaitStep | JourneyGateStep | JourneyWebhookCallStep;
export const JourneyHandoffSchema = z.object({
  id: StepIdSchema,
  from: StepIdSchema,
  /** The result of the from-step: its card finished (`done`) or was cancelled. Placeholders end with `done`. */
  on: z.enum(['done', 'cancelled', 'any', 'approved', 'rejected', 'failed']).default('done'),
  /** A step id (may equal `from` or an earlier step: a loop) or `end` (the instance completes). */
  to: z.union([StepIdSchema, z.literal('end')]),
  condition: JourneyConditionSchema.optional(),
  label: z.string().max(120).optional(),
});
export type JourneyHandoff = z.infer<typeof JourneyHandoffSchema>;

export const JourneyDefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  recordType: JourneyRecordTypeSchema,
  firstStepId: StepIdSchema,
  steps: z.array(JourneyStepSchema).min(1).max(50),
  /** Order matters: for one from-step the first handoff whose `on` and condition match is taken. */
  handoffs: z.array(JourneyHandoffSchema).max(200).default([]),
});
export type JourneyDefinition = z.infer<typeof JourneyDefinitionSchema>;
export type JourneyDefinitionInput = z.input<typeof JourneyDefinitionSchema>;

export const END_STEP = 'end' as const;

export function getJourneyStep(def: Pick<JourneyDefinition, 'steps'>, id: string): JourneyStep | undefined {
  return def.steps.find((s) => s.id === id);
}
