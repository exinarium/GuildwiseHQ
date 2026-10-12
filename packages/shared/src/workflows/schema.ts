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
  /** Architect report: `{reportPath, summary, location, commit?}` (protocol/ipc.ts `InvestigationDataSchema`). */
  'investigation',
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
  /**
   * Outcome guard: the outcome is offered and accepted only when the card's (boolean) field equals `equals`.
   * Same lookup as `Stage.when` (card column first, then `card.fields`). Absent: always allowed.
   */
  when: z.object({ field: z.string(), equals: z.unknown() }).optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

/** Where a sub-workflow's child card gets one of its fields from. */
export const SubworkflowSourceSchema = z.union([
  z.object({ field: z.string().min(1) }),
  z.object({ value: z.unknown() }),
  z.object({ template: z.string().max(2000) }),
]);
export type SubworkflowSource = z.infer<typeof SubworkflowSourceSchema>;

/**
 * Configuration of a `subworkflow` stage (docs/design/workflow-builder.md section 4). The server, never an agent, runs
 * the stage: entering it creates a child card in `workflowKey`. Wait mode: the parent is `waiting` until the child ends,
 * then takes the `done` outcome (child finished) or the `failed` outcome (child cancelled; `onFailure: 'fail'`).
 */
export const SubworkflowConfigSchema = z.object({
  workflowKey: z.string().min(1),
  /** 'same' project as the parent card, or another project of the same organisation. */
  project: z.union([z.literal('same'), z.object({ projectId: z.string().min(1) })]).default('same'),
  cardType: z.string().optional(),
  mode: z.enum(['wait', 'continue']).default('wait'),
  /** Absent: queued when every required field of the child is mapped, else draft (`effectiveSubworkflowStart`). */
  start: z.enum(['draft', 'queued']).optional(),
  /** Parent card -> child card: `to` is a child field key, `from` a parent field, a literal or a `{...}` template. */
  fieldsIn: z.array(z.object({ to: z.string().min(1), from: SubworkflowSourceSchema })).default([]),
  /** Wait mode, child finished: child field (`from`) -> parent field (`to`). */
  fieldsOut: z.array(z.object({ to: z.string().min(1), from: z.string().min(1) })).default([]),
  /** Wait mode, child cancelled: the parent takes its `failed` outcome, or carries on with `done`. */
  onFailure: z.enum(['fail', 'continue']).default('fail'),
});
export type SubworkflowConfig = z.infer<typeof SubworkflowConfigSchema>;
export type SubworkflowConfigInput = z.input<typeof SubworkflowConfigSchema>;

/** Deepest chain of sub-workflows allowed (a workflow starting a workflow starting a workflow = 3). */
export const MAX_SUBWORKFLOW_DEPTH = 3;

export const StageSchema = z.object({
  id: z.string().regex(IdPattern),
  label: z.string(),
  /** Board column label. */
  column: z.string(),
  /**
   * manual = moved by a user/BA command, never dispatched. subworkflow = run by the server: starts a child card
   * (`subworkflow` holds the details); never dispatched to an agent.
   */
  kind: z.enum(['agent', 'manual', 'terminal', 'subworkflow']),
  /** Required for kind 'subworkflow', absent otherwise. */
  subworkflow: SubworkflowConfigSchema.optional(),
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
  /**
   * Merge the latest main branch first: on the first worktree creation of a card at this stage the runner merges
   * `origin/<main>` into the working branch (docs/design/architect-and-workflows.md 2.5). Never on reuse.
   */
  syncMainBefore: z.boolean().default(false),
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
  /** Project variants only: the base workflow (key and version) this definition was materialised from. */
  extends: z.object({ key: z.string(), version: z.number().int().min(1) }).optional(),
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

/** Effective start state of a sub-workflow child: explicit, else queued only when every required child field is mapped. */
export function effectiveSubworkflowStart(
  cfg: Pick<SubworkflowConfig, 'start' | 'fieldsIn'>,
  requiredChildFields: readonly string[],
): 'draft' | 'queued' {
  if (cfg.start) return cfg.start;
  const mapped = new Set(cfg.fieldsIn.map((f) => f.to));
  return requiredChildFields.every((f) => mapped.has(f)) ? 'queued' : 'draft';
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

/**
 * Card types that may be created in any project whatever its workflow, with the workflow that runs them
 * (docs/design/restructure.md section 8.1). The project's own workflow wins when it lists the type.
 */
export const CROSS_PROJECT_CARD_TYPES: Readonly<Record<string, string>> = { research: 'research' };

/** The workflow key a project is in while it only researches (repositories are refused until it is converted). */
export const RESEARCH_STAGE_WORKFLOW = 'research';
export const isResearchStage = (workflowKey: string): boolean => workflowKey === RESEARCH_STAGE_WORKFLOW;
