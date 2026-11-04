import type { JourneyDefinition } from './schema.ts';
import { serverStepCycle, validateJourneyWaitsAndGates } from './steps-validate.ts';

export interface JourneyIssue {
  code: string;
  message: string;
  stepId?: string;
  handoffId?: string;
}
export interface JourneyValidation {
  errors: JourneyIssue[];
  warnings: JourneyIssue[];
}

export interface ValidateOptions {
  /** Workflow keys enabled in the journey's project. Omitted: not checked. */
  enabledWorkflowKeys?: ReadonlySet<string> | readonly string[];
  /** Runnable playbook keys. Omitted: not checked. */
  playbookKeys?: ReadonlySet<string> | readonly string[];
  /** Published form ids. Omitted: not checked. */
  publishedFormIds?: ReadonlySet<string> | readonly string[];
}

const RECORD_FIELDS = new Set(['type', 'status', 'visits']);
const has = (s: ReadonlySet<string> | readonly string[], k: string): boolean =>
  s instanceof Set ? s.has(k) : (s as readonly string[]).includes(k);

/**
 * Checks a definition. Saving is allowed with errors (a draft); starting an instance needs none.
 */
export function validateJourney(def: JourneyDefinition, opts: ValidateOptions = {}): JourneyValidation {
  const errors: JourneyIssue[] = [];
  const warnings: JourneyIssue[] = [];
  const ids = new Set<string>();
  for (const s of def.steps) {
    if (s.id === 'end')
      errors.push({
        code: 'reserved_id',
        message: '"end" is reserved and cannot be a step id.',
        stepId: s.id,
      });
    if (ids.has(s.id))
      errors.push({ code: 'duplicate_step', message: `Step id "${s.id}" is used twice.`, stepId: s.id });
    ids.add(s.id);
  }
  if (!ids.has(def.firstStepId))
    errors.push({
      code: 'unknown_first_step',
      message: `The first step "${def.firstStepId}" does not exist.`,
    });

  const hids = new Set<string>();
  for (const h of def.handoffs) {
    if (hids.has(h.id))
      errors.push({
        code: 'duplicate_handoff',
        message: `Handoff id "${h.id}" is used twice.`,
        handoffId: h.id,
      });
    hids.add(h.id);
    if (!ids.has(h.from))
      errors.push({
        code: 'unknown_from',
        message: `Handoff "${h.id}" leaves unknown step "${h.from}".`,
        handoffId: h.id,
      });
    if (h.to !== 'end' && !ids.has(h.to))
      errors.push({
        code: 'unknown_to',
        message: `Handoff "${h.id}" goes to unknown step "${h.to}".`,
        handoffId: h.id,
      });
    const c = h.condition;
    if (c) {
      if (c.source === 'record' && !RECORD_FIELDS.has(c.field))
        errors.push({
          code: 'unknown_record_field',
          message: `Handoff "${h.id}": a record has no field "${c.field}" (use type, status or visits).`,
          handoffId: h.id,
        });
      if ((c.op === 'lt' || c.op === 'gte') && typeof c.value !== 'number')
        errors.push({
          code: 'condition_value',
          message: `Handoff "${h.id}": "${c.op}" needs a number.`,
          handoffId: h.id,
        });
      if ((c.op === 'equals' || c.op === 'not_equals') && c.value === undefined)
        errors.push({
          code: 'condition_value',
          message: `Handoff "${h.id}": "${c.op}" needs a value.`,
          handoffId: h.id,
        });
    }
  }

  for (const s of def.steps) {
    if (s.kind !== 'workflow') continue;
    if (!s.workflowKey)
      errors.push({ code: 'no_workflow', message: `Step "${s.label}" has no workflow yet.`, stepId: s.id });
    else if (opts.enabledWorkflowKeys && !has(opts.enabledWorkflowKeys, s.workflowKey))
      errors.push({
        code: 'workflow_not_enabled',
        message: `Workflow ${s.workflowKey} (step "${s.label}") is not enabled in this project.`,
        stepId: s.id,
      });
    if (s.playbook && opts.playbookKeys && !has(opts.playbookKeys, s.playbook.key))
      warnings.push({
        code: 'unknown_playbook',
        message: `Playbook ${s.playbook.key} (step "${s.label}") was not found.`,
        stepId: s.id,
      });
  }

  // Reachability from the first step.
  if (ids.has(def.firstStepId)) {
    const seen = new Set<string>([def.firstStepId]);
    const queue = [def.firstStepId];
    while (queue.length) {
      const cur = queue.pop() as string;
      for (const h of def.handoffs)
        if (h.from === cur && h.to !== 'end' && ids.has(h.to) && !seen.has(h.to)) {
          seen.add(h.to);
          queue.push(h.to);
        }
    }
    for (const s of def.steps)
      if (!seen.has(s.id))
        warnings.push({
          code: 'unreachable',
          message: `Step "${s.label}" cannot be reached from the first step.`,
          stepId: s.id,
        });
  }

  const cyc = serverStepCycle(def);
  if (cyc)
    errors.push({
      code: 'server_step_cycle',
      message: 'A loop with no workflow step can never move: add a workflow step, a wait or a gate to it.',
      stepId: cyc,
    });

  const extra = validateJourneyWaitsAndGates(def, opts);
  errors.push(...extra.errors);
  warnings.push(...extra.warnings);

  return { errors, warnings };
}
