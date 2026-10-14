import { CardType } from '../cards/types.ts';
import type { RoleDefinition } from '../roles/schema.ts';
import { WorkflowDefinitionSchema } from './schema.ts';
import { type SubworkflowLookup, validateSubworkflowTargets } from './subworkflow.ts';
import { type ValidationIssue, validateWorkflow } from './validate.ts';

export interface CustomWorkflowContext {
  builtinWorkflowKeys: readonly string[];
  departments: readonly string[];
  /**
   * Resolves the targets of `subworkflow` stages (cycle, depth, approval, field checks). Absent: only the
   * target-independent checks run.
   */
  subworkflowLookup?: SubworkflowLookup;
}

/** Events a custom workflow may use: it moves cards with generic stage moves only. */
const CUSTOM_EVENTS = new Set(['StageCompleted', 'CardSpecified']);

/**
 * Full validation of a custom workflow draft: the nine rules of docs/ARCHITECTURE.md section 6.6 plus what only
 * custom definitions need (they cannot use the built-in workflows' special machinery or keys). `roles` is the catalogue
 * the draft's stages may name.
 */
export function validateCustomWorkflow(
  input: unknown,
  roles: readonly RoleDefinition[],
  ctx: CustomWorkflowContext,
): ValidationIssue[] {
  const issues = validateWorkflow(input, roles);
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) return issues;
  const def = parsed.data;
  const err = (code: ValidationIssue['code'], message: string, stageId?: string, outcomeId?: string) =>
    issues.push({ severity: 'error', rule: 0, code, message, stageId, outcomeId });
  if (def.builtIn) err('not_custom', 'a custom workflow cannot be marked built-in');
  if (!/^[a-z][a-z0-9_-]*$/.test(def.key))
    err('invalid_key', 'the key is lowercase letters, digits, - and _');
  if (ctx.builtinWorkflowKeys.includes(def.key))
    err('builtin_key', `'${def.key}' is a built-in workflow: pick another key`);
  if (def.fieldSet !== 'custom')
    err(
      'invalid_field_set',
      "custom workflows use the field set 'custom' (card fields come from customFields)",
    );
  const allowed = CardType.options.filter((t) => !['research', 'feed', 'regression'].includes(t));
  for (const t of def.cardTypes)
    if (!allowed.includes(t as never))
      err(
        'invalid_card_type',
        `card type '${t}' is not available to custom workflows (use ${allowed.join(', ')})`,
      );
  if (def.cardTypes.length === 0) err('invalid_card_type', 'the workflow needs at least one card type');
  if (def.department && !ctx.departments.includes(def.department))
    err('unknown_department', `department '${def.department}' does not exist: create it first`);
  if (ctx.subworkflowLookup) issues.push(...validateSubworkflowTargets(input, ctx.subworkflowLookup));
  for (const s of def.stages) {
    if (s.kind === 'manual' && s.id !== def.initialStage)
      err(
        'manual_stage_not_initial',
        `stage '${s.id}': only the first stage may be a manual (BA/manager) stage`,
        s.id,
      );
    if (s.kind === 'human')
      err(
        'human_stage_not_custom',
        `stage '${s.id}': person-completed steps (manual QA) are built in; custom workflows cannot use them yet`,
        s.id,
      );
    if (s.fallbackRole !== undefined)
      err('unknown_fallback_role', `stage '${s.id}': custom steps have no fallback role`, s.id);
    if (s.claimRole === 'devops')
      err('role_not_claimable', 'the DevOps engineer cannot claim workflow stages', s.id);
    for (const o of s.outcomes) {
      if (!CUSTOM_EVENTS.has(o.event))
        err(
          'unsupported_custom_event',
          `'${s.id}.${o.id}': custom workflows move cards with StageCompleted only`,
          s.id,
          o.id,
        );
      if (o.event === 'CardSpecified' && s.id !== def.initialStage)
        err(
          'unsupported_custom_event',
          `'${s.id}.${o.id}': CardSpecified belongs to the first stage`,
          s.id,
          o.id,
        );
      if (o.data !== 'none')
        err(
          'unsupported_custom_event',
          `'${s.id}.${o.id}': custom outcomes carry no structured data`,
          s.id,
          o.id,
        );
      if (o.effect !== 'none')
        err('invalid_effect', `'${s.id}.${o.id}': custom outcomes have no effects`, s.id, o.id);
    }
  }
  return issues;
}
