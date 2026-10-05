import { z } from 'zod';

const IdPattern = /^[a-z][a-z0-9_]*$/;

export const OutcomeEventSchema = z.enum([
  'ReviewRequested',
  'ReviewApproved',
  'ChangesRequested',
  'TestPassed',
  'TestFailed',
  'StageCompleted',
  'CardFinalized',
  'ResearchPublished',
  'DigestPosted',
  'CardSpecified',
]);
export type OutcomeEvent = z.infer<typeof OutcomeEventSchema>;

export const OutcomeDataKindSchema = z.enum([
  'none',
  'diffStats',
  'review',
  'testEvidence',
  'publication',
  'candidates',
  'digest',
  'finalize',
]);
export type OutcomeDataKind = z.infer<typeof OutcomeDataKindSchema>;

export const OutcomeEffectSchema = z.enum(['none', 'spawn_bug_child', 'resume_parent', 'finalize']);

export const OutcomeSchema = z.object({
  /** 'handoff' | 'approve' | 'changes' | 'pass' | 'fail' | 'done' | ... */
  id: z.string().regex(IdPattern),
  label: z.string(),
  kind: z.enum(['success', 'failure']),
  /** Target stage id (may equal the current stage for 'waiting' effects). */
  to: z.string(),
  event: OutcomeEventSchema,
  data: OutcomeDataKindSchema.default('none'),
  /** Increments rework_round, routes to original builder first. */
  rework: z.boolean().default(false),
  effect: OutcomeEffectSchema.default('none'),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

export const StageSchema = z.object({
  id: z.string().regex(IdPattern),
  label: z.string(),
  /** Board column label. */
  column: z.string(),
  /** manual = moved by a user/BA command, never dispatched. */
  kind: z.enum(['agent', 'manual', 'terminal']),
  /** Required for kind 'agent'. */
  claimRole: z.string().nullable(),
  seniorOnly: z.boolean().default(false),
  /** Card field keys that must be filled to ENTER the stage. */
  requiredFields: z.array(z.string()).default([]),
  /** Rendered into the shift prompt. */
  doneCriteria: z.string(),
  outcomes: z.array(OutcomeSchema).default([]),
  /** Stage is skipped when the (boolean) field is not equal to `equals`. */
  when: z.object({ field: z.string(), equals: z.unknown() }).optional(),
  worktree: z.enum(['create', 'reuse', 'none']).default('none'),
  rebaseBefore: z.boolean().default(false),
  approvals: z.object({ small: z.number().int().min(1), large: z.number().int().min(1) }).optional(),
  maxShiftMinutes: z.number().int().min(5).max(480).default(60),
  requiredCapabilities: z.array(z.string()).default([]),
});
export type Stage = z.infer<typeof StageSchema>;

export const CustomFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'markdown', 'list', 'number', 'boolean', 'url-list']),
  required: z.boolean(),
});
export type CustomField = z.infer<typeof CustomFieldSchema>;

export const WorkflowDefinitionSchema = z.object({
  key: z.string(),
  version: z.number().int().min(1),
  name: z.string(),
  department: z.string().optional(),
  builtIn: z.boolean(),
  /** 'code' | 'research' | 'feed' | custom field-set id. */
  fieldSet: z.string(),
  customFields: z.array(CustomFieldSchema).default([]),
  cardTypes: z.array(z.string()),
  initialStage: z.string(),
  stages: z.array(StageSchema).min(2),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
/** Authoring shape (defaults not yet applied). */
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinitionSchema>;

export function getStage(def: Pick<WorkflowDefinition, 'stages'>, stageId: string): Stage | undefined {
  return def.stages.find((s) => s.id === stageId);
}

export function getOutcome(
  def: Pick<WorkflowDefinition, 'stages'>,
  stageId: string,
  outcomeId: string,
): Outcome | undefined {
  return getStage(def, stageId)?.outcomes.find((o) => o.id === outcomeId);
}

/** First stage a card enters when it is created in the 'draft'/'queued' states for this workflow. */
export function firstAgentStage(def: Pick<WorkflowDefinition, 'stages' | 'initialStage'>): Stage | undefined {
  return def.stages.find((s) => s.kind === 'agent');
}

/** Same check the server's regression command uses: a workflow has a test stage when a stage has the id 'test'. */
export function workflowHasTestStage(def: Pick<WorkflowDefinition, 'stages'>): boolean {
  return getStage(def, 'test') !== undefined;
}

/** True when any stage works in a git worktree, i.e. the project needs repositories (code); false for research/feed. */
export function workflowUsesRepos(def: Pick<WorkflowDefinition, 'stages'>): boolean {
  return def.stages.some((s) => s.worktree !== 'none');
}
