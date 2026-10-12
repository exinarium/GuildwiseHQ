import { fieldCatalogue } from '../cards/fields.ts';
import { type RoleDefinition, roleClaimsStage } from '../roles/schema.ts';

import { type Stage, WorkflowDefinitionSchema } from './schema.ts';

export type IssueCode =
  // rule 1
  | 'invalid_schema'
  | 'duplicate_stage_id'
  | 'duplicate_outcome_id'
  | 'missing_initial_stage'
  // rule 2
  | 'no_terminal_stage'
  | 'terminal_has_outcomes'
  | 'no_outcomes'
  | 'no_success_outcome'
  | 'outcome_guard_gap'
  // rule 3
  | 'agent_stage_without_role'
  | 'unknown_role'
  | 'role_cannot_claim_stage'
  | 'role_not_senior'
  // rule 4
  | 'unknown_outcome_target'
  // rule 5
  | 'unreachable_stage'
  // rule 6
  | 'no_path_to_terminal'
  | 'failure_no_path_to_terminal'
  // rule 7
  | 'unknown_required_field'
  // rule 8
  | 'invalid_effect'
  // rule 9
  | 'when_field_not_boolean'
  // rule 10 (sub-workflow stages; target-dependent checks live in subworkflow.ts)
  | 'subworkflow_missing_config'
  | 'subworkflow_config_misplaced'
  | 'subworkflow_has_role'
  | 'subworkflow_no_failed_route'
  | 'subworkflow_duplicate_mapping'
  | 'subworkflow_unknown_field'
  | 'subworkflow_field_out_in_continue'
  | 'subworkflow_unknown_target'
  | 'subworkflow_target_not_approved'
  | 'subworkflow_target_not_enabled'
  | 'subworkflow_cross_org'
  | 'subworkflow_cycle'
  | 'subworkflow_too_deep'
  | 'subworkflow_unknown_card_type'
  | 'subworkflow_field_type'
  | 'subworkflow_required_unmapped'
  // custom workflows only
  | 'not_custom'
  | 'invalid_key'
  | 'builtin_key'
  | 'invalid_field_set'
  | 'invalid_card_type'
  | 'unknown_department'
  | 'manual_stage_not_initial'
  | 'role_not_claimable'
  | 'unsupported_custom_event'
  // project variants only
  | 'variant_base_not_allowed'
  | 'variant_base_mismatch'
  | 'variant_invalid_insertion'
  | 'variant_definition_mismatch'
  // warnings
  | 'missing_done_criteria'
  | 'too_many_stages';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** Rule number from docs/ARCHITECTURE.md section 6.6 (0 for warnings). */
  rule: number;
  code: IssueCode;
  message: string;
  stageId?: string;
  outcomeId?: string;
}

const MAX_STAGES_WARNING = 12;

/**
 * Validates a workflow definition (draft save and again before approval). Returns errors and warnings;
 * an empty array means the definition is valid and clean. `roleCatalogue` should contain the active roles
 * (built-in + org) that may be named by `claimRole`.
 */
export function validateWorkflow(
  input: unknown,
  roleCatalogue: readonly RoleDefinition[],
): ValidationIssue[] {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({
      severity: 'error' as const,
      rule: 1,
      code: 'invalid_schema' as const,
      message: `${i.path.join('.') || '(root)'}: ${i.message}`,
    }));
  }
  const def = parsed.data;
  const issues: ValidationIssue[] = [];
  const err = (rule: number, code: IssueCode, message: string, stageId?: string, outcomeId?: string) =>
    issues.push({ severity: 'error', rule, code, message, stageId, outcomeId });
  const warn = (code: IssueCode, message: string, stageId?: string) =>
    issues.push({ severity: 'warning', rule: 0, code, message, stageId });

  const byId = new Map<string, Stage>();

  // Rule 1: unique stage ids, unique outcome ids per stage, initialStage exists.
  for (const s of def.stages) {
    if (byId.has(s.id)) err(1, 'duplicate_stage_id', `stage id '${s.id}' is used more than once`, s.id);
    else byId.set(s.id, s);
    const seen = new Set<string>();
    for (const o of s.outcomes) {
      if (seen.has(o.id))
        err(1, 'duplicate_outcome_id', `outcome id '${o.id}' repeats in stage '${s.id}'`, s.id, o.id);
      seen.add(o.id);
    }
  }
  if (!byId.has(def.initialStage)) {
    err(1, 'missing_initial_stage', `initialStage '${def.initialStage}' is not a stage`);
  }

  // Rule 2: terminal stages and outcomes.
  if (!def.stages.some((s) => s.kind === 'terminal'))
    err(2, 'no_terminal_stage', 'the workflow has no terminal stage');
  for (const s of def.stages) {
    if (s.kind === 'terminal') {
      if (s.outcomes.length > 0)
        err(2, 'terminal_has_outcomes', `terminal stage '${s.id}' must have no outcomes`, s.id);
      continue;
    }
    if (s.outcomes.length === 0) err(2, 'no_outcomes', `stage '${s.id}' has no outcomes`, s.id);
    else if (!s.outcomes.some((o) => o.kind === 'success')) {
      err(2, 'no_success_outcome', `stage '${s.id}' has no success outcome`, s.id);
    } else {
      const gap = guardGap(s);
      if (gap) err(2, 'outcome_guard_gap', `stage '${s.id}' has no success outcome when ${gap}`, s.id);
    }
  }

  // Rule 3: agent stages need a claimable role (with a senior level when seniorOnly).
  for (const s of def.stages) {
    if (s.kind !== 'agent') continue;
    if (!s.claimRole) {
      err(3, 'agent_stage_without_role', `agent stage '${s.id}' needs a claimRole`, s.id);
      continue;
    }
    const role = roleCatalogue.find((r) => r.key === s.claimRole);
    if (!role) {
      err(3, 'unknown_role', `stage '${s.id}' names unknown role '${s.claimRole}'`, s.id);
      continue;
    }
    // A project variant's inherited stages accept the roles that claim the base workflow's stage.
    if (
      !roleClaimsStage(role, def.key, s.id) &&
      !(def.extends && roleClaimsStage(role, def.extends.key, s.id))
    ) {
      err(3, 'role_cannot_claim_stage', `role '${role.key}' cannot claim stage '${def.key}.${s.id}'`, s.id);
    }
    if (s.seniorOnly && !role.seniorityLevels.includes('senior')) {
      err(
        3,
        'role_not_senior',
        `stage '${s.id}' is senior-only but role '${role.key}' has no senior level`,
        s.id,
      );
    }
  }

  // Rule 4: outcome targets exist.
  for (const s of def.stages) {
    for (const o of s.outcomes) {
      if (!byId.has(o.to))
        err(
          4,
          'unknown_outcome_target',
          `outcome '${s.id}.${o.id}' targets unknown stage '${o.to}'`,
          s.id,
          o.id,
        );
    }
  }

  // Graph edges: outcome targets plus `when`-skip edges (a skipped target continues via its first success outcome).
  const edges = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    const set = edges.get(from) ?? new Set<string>();
    set.add(to);
    edges.set(from, set);
  };
  for (const s of def.stages) {
    for (const o of s.outcomes) {
      if (!byId.has(o.to)) continue;
      addEdge(s.id, o.to);
      let t = byId.get(o.to);
      const hops = new Set<string>();
      while (t?.when && !hops.has(t.id)) {
        hops.add(t.id);
        const successes = t.outcomes.filter((x) => x.kind === 'success');
        // Guarded success outcomes: any of them may be the one followed, so all become edges.
        const followed = successes.some((x) => x.when) ? successes : successes.slice(0, 1);
        const next = followed[0];
        if (!next || !byId.has(next.to)) break;
        for (const f of followed) if (byId.has(f.to)) addEdge(s.id, f.to);
        t = byId.get(next.to);
      }
    }
  }
  const reach = (starts: string[]): Set<string> => {
    const seen = new Set<string>(starts);
    const queue = [...starts];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const n of edges.get(cur) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return seen;
  };

  // Rule 5: every stage reachable from initialStage.
  if (byId.has(def.initialStage)) {
    const reachable = reach([def.initialStage]);
    for (const s of def.stages) {
      if (!reachable.has(s.id))
        err(5, 'unreachable_stage', `stage '${s.id}' is not reachable from '${def.initialStage}'`, s.id);
    }
  }

  // Rule 6: every stage reaches a terminal; so does every failure outcome's target.
  const terminals = new Set(def.stages.filter((s) => s.kind === 'terminal').map((s) => s.id));
  if (terminals.size > 0) {
    const reachesTerminal = (id: string) => {
      const r = reach([id]);
      for (const t of terminals) if (r.has(t)) return true;
      return false;
    };
    for (const s of def.stages) {
      if (!reachesTerminal(s.id))
        err(6, 'no_path_to_terminal', `stage '${s.id}' cannot reach a terminal stage`, s.id);
      for (const o of s.outcomes) {
        if (o.kind === 'failure' && byId.has(o.to) && !reachesTerminal(o.to)) {
          err(
            6,
            'failure_no_path_to_terminal',
            `failure outcome '${s.id}.${o.id}' leads to a stage that cannot reach a terminal`,
            s.id,
            o.id,
          );
        }
      }
    }
  }

  // Rule 7: requiredFields reference known field keys.
  const catalogue = fieldCatalogue(def.fieldSet, def.customFields);
  for (const s of def.stages) {
    for (const f of s.requiredFields) {
      if (!catalogue[f])
        err(7, 'unknown_required_field', `stage '${s.id}' requires unknown field '${f}'`, s.id);
    }
  }

  // Rule 8: effect constraints.
  for (const s of def.stages) {
    for (const o of s.outcomes) {
      if (o.effect === 'spawn_bug_child' && o.to !== s.id) {
        err(8, 'invalid_effect', `'${s.id}.${o.id}': spawn_bug_child must target the same stage`, s.id, o.id);
      }
      if (o.effect === 'finalize' && !terminals.has(o.to)) {
        err(8, 'invalid_effect', `'${s.id}.${o.id}': finalize must target a terminal stage`, s.id, o.id);
      }
      if (o.effect === 'resume_parent' && !def.cardTypes.includes('bug')) {
        err(8, 'invalid_effect', `'${s.id}.${o.id}': resume_parent requires 'bug' in cardTypes`, s.id, o.id);
      }
    }
  }

  // Rule 9: when.field must be a boolean field.
  for (const s of def.stages) {
    if (!s.when) continue;
    const meta = catalogue[s.when.field];
    if (meta?.kind !== 'boolean') {
      err(
        9,
        'when_field_not_boolean',
        `stage '${s.id}': when.field '${s.when.field}' is not a boolean field`,
        s.id,
      );
    }
  }

  // Rule 9 (cont.): outcome guards (Outcome.when) follow the same rule.
  for (const s of def.stages) {
    for (const o of s.outcomes) {
      if (!o.when) continue;
      const meta = catalogue[o.when.field];
      if (meta?.kind !== 'boolean' || typeof o.when.equals !== 'boolean') {
        err(
          9,
          'when_field_not_boolean',
          `outcome '${s.id}.${o.id}': when.field '${o.when.field}' is not a boolean field compared with true or false`,
          s.id,
          o.id,
        );
      }
    }
  }

  // Rule 10: sub-workflow stages (target-independent part; see validateSubworkflowTargets for the rest).
  for (const s of def.stages) {
    const cfg = s.subworkflow;
    if (s.kind !== 'subworkflow') {
      if (cfg)
        err(
          10,
          'subworkflow_config_misplaced',
          `stage '${s.id}' is not a sub-workflow stage but has a subworkflow block`,
          s.id,
        );
      continue;
    }
    if (!cfg) {
      err(10, 'subworkflow_missing_config', `sub-workflow stage '${s.id}' needs a subworkflow block`, s.id);
      continue;
    }
    if (s.claimRole)
      err(
        10,
        'subworkflow_has_role',
        `sub-workflow stage '${s.id}' is run by the server: it takes no claimRole`,
        s.id,
      );
    const seenTo = new Set<string>();
    for (const m of cfg.fieldsIn) {
      if (seenTo.has(m.to))
        err(
          10,
          'subworkflow_duplicate_mapping',
          `stage '${s.id}' fills child field '${m.to}' more than once`,
          s.id,
        );
      seenTo.add(m.to);
      if ('field' in m.from && !catalogue[m.from.field])
        err(
          10,
          'subworkflow_unknown_field',
          `stage '${s.id}' reads unknown field '${m.from.field}' of this card`,
          s.id,
        );
    }
    if (cfg.mode === 'continue' && cfg.fieldsOut.length > 0)
      err(
        10,
        'subworkflow_field_out_in_continue',
        `stage '${s.id}' continues at once: it cannot copy fields back from the child`,
        s.id,
      );
    for (const m of cfg.fieldsOut) {
      if (!catalogue[m.to])
        err(
          10,
          'subworkflow_unknown_field',
          `stage '${s.id}' writes unknown field '${m.to}' of this card`,
          s.id,
        );
    }
    if (
      cfg.mode === 'wait' &&
      cfg.onFailure === 'fail' &&
      s.outcomes.length > 0 &&
      !s.outcomes.some((o) => o.kind === 'failure')
    )
      err(
        10,
        'subworkflow_no_failed_route',
        `sub-workflow stage '${s.id}' needs a failure route for a cancelled child`,
        s.id,
      );
  }

  // Warnings.
  for (const s of def.stages) {
    if (s.kind !== 'terminal' && s.doneCriteria.trim() === '') {
      warn('missing_done_criteria', `stage '${s.id}' has no doneCriteria`, s.id);
    }
  }
  if (def.stages.length > MAX_STAGES_WARNING) {
    warn('too_many_stages', `the workflow has ${def.stages.length} stages (more than ${MAX_STAGES_WARNING})`);
  }

  return issues;
}

/**
 * Rule 2 with outcome guards: for every combination of values of the boolean guard fields used by the stage's success
 * outcomes, at least one success outcome must be allowed. Returns a description of the first uncovered combination,
 * or null. A stage without guarded success outcomes is covered as soon as it has a success outcome.
 */
function guardGap(stage: Stage): string | null {
  const successes = stage.outcomes.filter((o) => o.kind === 'success');
  const fields = [...new Set(successes.flatMap((o) => (o.when ? [o.when.field] : [])))];
  if (fields.length === 0 || fields.length > 8) return null;
  for (let mask = 0; mask < 1 << fields.length; mask++) {
    const values = new Map(fields.map((f, i) => [f, Boolean(mask & (1 << i))]));
    const covered = successes.some((o) => !o.when || values.get(o.when.field) === o.when.equals);
    if (!covered) return fields.map((f) => `${f}=${values.get(f)}`).join(', ');
  }
  return null;
}

export const hasErrors = (issues: readonly ValidationIssue[]): boolean =>
  issues.some((i) => i.severity === 'error');
