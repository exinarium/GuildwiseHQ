import { z } from 'zod';
import type { RoleDefinition } from '../roles/schema.ts';
import { roleClaimsStage } from '../roles/schema.ts';
import {
  ApproverSchema,
  OutcomeSchema,
  type Stage,
  StageSchema,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from './schema.ts';
import { type SubworkflowLookup, validateSubworkflowTargets } from './subworkflow.ts';
import { type ValidationIssue, validateWorkflow } from './validate.ts';

/**
 * Project variants (docs/design/architect-and-workflows.md section 4.2): a project's own version of a workflow,
 * authored as stages INSERTED after existing ones. The variant is stored materialised (full definition), so cards pin
 * it like any other workflow version and the dispatcher needs nothing new.
 */

/** Workflows a variant cannot be based on (internal or special machinery). */
export const NON_VARIANT_BASES: readonly string[] = ['code-bugfix', 'feed', 'research'];

/** The stage an inserted step is, as the author writes it. Everything else is fixed (agent stage, StageCompleted). */
export const InsertedStageSchema = StageSchema.pick({
  id: true,
  label: true,
  seniorOnly: true,
  requiredFields: true,
  doneCriteria: true,
  syncMainBefore: true,
  rebaseBefore: true,
  maxShiftMinutes: true,
  requiredCapabilities: true,
  environment: true,
}).extend({
  /** Board column; defaults to the label. */
  column: z.string().optional(),
  /** `approval`: a person approves on the desk instead of an agent working (backlog #16). Default: an agent step. */
  kind: z.enum(['agent', 'approval']).default('agent'),
  /** Agent steps: the role that works the step. */
  claimRole: z.string().min(1).optional(),
  /** Approval steps: who approves (default: the organization's Owner). */
  approver: ApproverSchema.optional(),
  /** Approval steps: the earlier step a send back goes to (default: the step the approval is inserted after). */
  sendBackTo: z.string().min(1).optional(),
  /**
   * Absent (the usual case): derived from where the step sits: `create` before the workflow's first worktree stage,
   * `reuse` after it, `none` in a workflow that never uses a worktree.
   */
  worktree: z.enum(['create', 'reuse', 'none']).optional(),
  /** What the step's `done` outcome carries: nothing, or an architect report (`investigate*` steps). */
  data: z.enum(['none', 'investigation']).default('none'),
});
export type InsertedStage = z.infer<typeof InsertedStageSchema>;

export const StageInsertionSchema = z.object({
  /** An existing stage id (base or earlier insertion), not terminal. */
  after: z.string(),
  stage: InsertedStageSchema,
  /** Which success outcomes of `after` are redirected to the new stage; default: all (they must share one target). */
  redirect: z.array(z.string()).optional(),
});
export type StageInsertion = z.infer<typeof StageInsertionSchema>;
export type StageInsertionInput = z.input<typeof StageInsertionSchema>;

export const WorkflowVariantSpecSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  projectId: z.uuid(),
  base: z.object({ key: z.string().min(1), version: z.number().int().min(1) }),
  /** May narrow the base's card types, never widen them. Default: the base's. */
  cardTypes: z.array(z.string()).optional(),
  insertions: z.array(StageInsertionSchema).min(1).max(8),
});
export type WorkflowVariantSpec = z.infer<typeof WorkflowVariantSpecSchema>;
export type WorkflowVariantSpecInput = z.input<typeof WorkflowVariantSpecSchema>;

export type VariantErrorCode =
  | 'unknown_after'
  | 'after_terminal'
  | 'duplicate_stage_id'
  | 'unknown_redirect'
  | 'nothing_to_redirect'
  | 'ambiguous_successor'
  | 'missing_role'
  | 'bad_send_back';

export class VariantError extends Error {
  constructor(
    message: string,
    readonly code: VariantErrorCode,
    readonly stageId?: string,
  ) {
    super(message);
    this.name = 'VariantError';
  }
}

/**
 * Applies the insertions to the base, in order. For an insertion after stage X, every redirected success outcome of X
 * now targets the new stage, whose own `done` outcome targets what X used to lead to. Events stay as the base had them
 * (`test.pass` keeps `TestPassed`). Throws `VariantError` when an insertion cannot be placed.
 */
export function materialiseVariant(
  base: WorkflowDefinition,
  spec: WorkflowVariantSpec,
  version = 1,
): WorkflowDefinition {
  const stages: Stage[] = structuredClone(base.stages);
  for (const ins of spec.insertions) {
    const idx = stages.findIndex((s) => s.id === ins.after);
    const after = stages[idx];
    if (!after) throw new VariantError(`there is no stage '${ins.after}' to insert after`, 'unknown_after');
    if (after.kind === 'terminal')
      throw new VariantError(`cannot insert after the final stage '${after.id}'`, 'after_terminal', after.id);
    if (stages.some((s) => s.id === ins.stage.id))
      throw new VariantError(
        `stage id '${ins.stage.id}' is already used`,
        'duplicate_stage_id',
        ins.stage.id,
      );
    for (const id of ins.redirect ?? [])
      if (!after.outcomes.some((o) => o.id === id && o.kind === 'success'))
        throw new VariantError(
          `stage '${after.id}' has no success outcome '${id}' to redirect`,
          'unknown_redirect',
          after.id,
        );
    const redirected = after.outcomes.filter(
      (o) => o.kind === 'success' && o.to !== after.id && (!ins.redirect || ins.redirect.includes(o.id)),
    );
    if (redirected.length === 0)
      throw new VariantError(
        `stage '${after.id}' has no success outcome to continue from`,
        'nothing_to_redirect',
        after.id,
      );
    const targets = [...new Set(redirected.map((o) => o.to))];
    if (targets.length > 1)
      throw new VariantError(
        `stage '${after.id}' leads to ${targets.join(' and ')}: choose which outcomes the new step follows (redirect)`,
        'ambiguous_successor',
        after.id,
      );
    const successor = targets[0] as string;
    const s = ins.stage;
    if (s.kind === 'approval') {
      const back = s.sendBackTo ?? after.id;
      const backStage = stages.find((x) => x.id === back);
      if (!backStage || (backStage.kind !== 'agent' && backStage.kind !== 'manual'))
        throw new VariantError(
          `a send back from '${s.id}' goes to an agent step; '${back}' is not one`,
          'bad_send_back',
          s.id,
        );
      for (const o of redirected) o.to = s.id;
      stages.splice(
        idx + 1,
        0,
        StageSchema.parse({
          id: s.id,
          label: s.label,
          column: s.column?.trim() || s.label,
          kind: 'human',
          human: { purpose: 'approval', approver: s.approver ?? { kind: 'org_owner' } },
          claimRole: null,
          requiredFields: [],
          doneCriteria: s.doneCriteria,
          outcomes: [
            OutcomeSchema.parse({
              id: 'approve',
              label: 'Approve',
              kind: 'success',
              to: successor,
              event: 'StageCompleted',
            }),
            OutcomeSchema.parse({
              id: 'send_back',
              label: 'Send back',
              kind: 'failure',
              to: back,
              event: 'StageCompleted',
              rework: true,
            }),
          ],
        }),
      );
      continue;
    }
    if (!s.claimRole) throw new VariantError(`step '${s.id}' needs a role`, 'missing_role', s.id);
    for (const o of redirected) o.to = ins.stage.id;
    const usesWorktree = stages.some((x) => x.worktree !== 'none');
    const worktree =
      s.worktree ??
      (!usesWorktree
        ? 'none'
        : stages.slice(0, idx + 1).some((x) => x.worktree === 'create')
          ? 'reuse'
          : 'create');
    stages.splice(
      idx + 1,
      0,
      StageSchema.parse({
        id: s.id,
        label: s.label,
        column: s.column?.trim() || s.label,
        kind: 'agent',
        claimRole: s.claimRole,
        seniorOnly: s.seniorOnly,
        requiredFields: s.requiredFields,
        doneCriteria: s.doneCriteria,
        outcomes: [
          OutcomeSchema.parse({
            id: 'done',
            label: 'Done',
            kind: 'success',
            to: successor,
            event: 'StageCompleted',
            data: s.data,
          }),
        ],
        worktree,
        rebaseBefore: s.rebaseBefore,
        syncMainBefore: s.syncMainBefore,
        maxShiftMinutes: s.maxShiftMinutes,
        requiredCapabilities: s.requiredCapabilities,
        environment: s.environment,
      }),
    );
  }
  return WorkflowDefinitionSchema.parse({
    ...structuredClone(base),
    key: spec.key,
    version,
    name: spec.name,
    builtIn: false,
    cardTypes: spec.cardTypes ?? base.cardTypes,
    stages,
    extends: { key: base.key, version: base.version },
  });
}

/** Ids of the stages a variant adds to its base. */
export const insertedStageIds = (spec: Pick<WorkflowVariantSpec, 'insertions'>): string[] =>
  spec.insertions.map((i) => i.stage.id);

/** Template "Investigate & design": an architect step after any stage (`investigate_after_<stage>`). */
export function investigateInsertion(after: string): StageInsertionInput {
  return {
    after,
    stage: {
      id: `investigate_after_${after}`,
      label: 'Investigate & design',
      claimRole: 'architect',
      seniorOnly: true,
      doneCriteria:
        'The code and the other repositories were investigated; the findings, a comparison with best practice and a design or recommendation are in the report, committed on the card branch.',
      data: 'investigation',
      maxShiftMinutes: 90,
    },
  };
}

/**
 * Template "Smoke test": a tester step after any stage that runs against the project's running environment
 * (`environment: 'project'`, Project settings > Run & test). Needs `smoke*` as the step id (the tester claims it).
 */
export function smokeTestInsertion(after: string): StageInsertionInput {
  return {
    after,
    stage: {
      id: `smoke_after_${after}`,
      label: 'Smoke test',
      claimRole: 'tester',
      doneCriteria:
        'The running environment answers and its main flows work: the checks named on the card and the project suites were run against it and reported.',
      environment: 'project',
      maxShiftMinutes: 60,
    },
  };
}

export interface VariantContext {
  builtinWorkflowKeys: readonly string[];
  /** Resolves the targets of the base's `subworkflow` stages (cycle, depth, approval, enabled). Absent: not checked. */
  subworkflowLookup?: SubworkflowLookup;
}

export interface VariantValidation {
  issues: ValidationIssue[];
  /** The materialised definition; absent when an insertion could not be placed. */
  definition?: WorkflowDefinition;
}

/**
 * Full validation of a variant: the nine workflow rules on the materialised definition (an inherited stage accepts
 * the roles that claim the base stage), plus what only variants need. `base` must be the exact version the spec names.
 * `opts.stored` (optional) is a stored definition that must equal the materialisation (tamper / drift check).
 */
export function validateVariant(
  specInput: unknown,
  base: WorkflowDefinition,
  roles: readonly RoleDefinition[],
  ctx: VariantContext,
  opts: { version?: number; stored?: unknown } = {},
): VariantValidation {
  const parsed = WorkflowVariantSpecSchema.safeParse(specInput);
  if (!parsed.success)
    return {
      issues: parsed.error.issues.map((i) => ({
        severity: 'error' as const,
        rule: 1,
        code: 'invalid_schema' as const,
        message: `${i.path.join('.') || '(root)'}: ${i.message}`,
      })),
    };
  const spec = parsed.data;
  const issues: ValidationIssue[] = [];
  const err = (code: ValidationIssue['code'], message: string, stageId?: string) =>
    issues.push({ severity: 'error', rule: 0, code, message, stageId });

  if (NON_VARIANT_BASES.includes(base.key) || base.extends || (base.builtIn && base.key !== 'code'))
    err(
      'variant_base_not_allowed',
      `'${base.key}' cannot be the base of a variant (use code or a custom workflow)`,
    );
  if (spec.base.key !== base.key || spec.base.version !== base.version)
    err(
      'variant_base_mismatch',
      `the variant names ${spec.base.key} v${spec.base.version}, not ${base.key} v${base.version}`,
    );
  if (!/^[a-z][a-z0-9_-]*$/.test(spec.key))
    err('invalid_key', 'the key is lowercase letters, digits, - and _');
  if (ctx.builtinWorkflowKeys.includes(spec.key))
    err('builtin_key', `'${spec.key}' is a built-in workflow: pick another key`);
  if (spec.cardTypes) {
    if (spec.cardTypes.length === 0) err('invalid_card_type', 'the variant needs at least one card type');
    for (const t of spec.cardTypes)
      if (!base.cardTypes.includes(t))
        err(
          'invalid_card_type',
          `card type '${t}' is not in the base workflow (a variant may only narrow them)`,
        );
  }

  let def: WorkflowDefinition;
  try {
    def = materialiseVariant(base, spec, opts.version ?? 1);
  } catch (e) {
    if (e instanceof VariantError) {
      err('variant_invalid_insertion', e.message, e.stageId);
      return { issues };
    }
    throw e;
  }

  // Inserted stages: the author controls only the step's own fields; check what they ask for.
  const order = def.stages.map((s) => s.id);
  for (const ins of spec.insertions) {
    const s = def.stages[order.indexOf(ins.stage.id)] as Stage;
    if (s.kind === 'human') continue; // an approval step: checked by the workflow rules (rule 12)
    const role = roles.find((r) => r.key === s.claimRole);
    if (s.claimRole === 'devops')
      err('role_not_claimable', 'the DevOps engineer cannot claim workflow stages', s.id);
    if (ins.stage.data === 'investigation' && role) {
      if (!(s.id.startsWith('investigate') && roleClaimsStage(role, def.key, s.id)))
        err(
          'variant_invalid_insertion',
          `step '${s.id}': a report (investigation data) needs an investigate step claimed by the architect`,
          s.id,
        );
    }
    const before = def.stages.slice(0, order.indexOf(s.id));
    const worktreeBefore = before.some((x) => x.worktree === 'create');
    const usesWorktree = base.stages.some((x) => x.worktree !== 'none');
    if (!usesWorktree && s.worktree !== 'none')
      err('variant_invalid_insertion', `step '${s.id}': this workflow uses no worktree`, s.id);
    else if (usesWorktree && s.worktree === 'none')
      err('variant_invalid_insertion', `step '${s.id}': this workflow works in a worktree`, s.id);
    else if (s.worktree === 'create' && worktreeBefore)
      err('variant_invalid_insertion', `step '${s.id}': a worktree already exists here, use 'reuse'`, s.id);
    else if (s.worktree === 'reuse' && !worktreeBefore)
      err(
        'variant_invalid_insertion',
        `step '${s.id}': no worktree exists before this step yet, use 'create'`,
        s.id,
      );
  }

  issues.push(...validateWorkflow(def, roles));
  if (ctx.subworkflowLookup) issues.push(...validateSubworkflowTargets(def, ctx.subworkflowLookup));

  // jsonb does not keep key order: compare the schema-normalised forms.
  const stored = opts.stored === undefined ? undefined : WorkflowDefinitionSchema.safeParse(opts.stored);
  if (stored && (!stored.success || JSON.stringify(stored.data) !== JSON.stringify(def)))
    err(
      'variant_definition_mismatch',
      'the stored definition no longer matches its insertions on the base workflow: rebase or redraft the variant',
    );
  return { issues, definition: def };
}
