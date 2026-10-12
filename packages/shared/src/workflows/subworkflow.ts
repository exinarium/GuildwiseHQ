import { type FieldMeta, fieldCatalogue } from '../cards/fields.ts';
import {
  firstAgentStage,
  MAX_SUBWORKFLOW_DEPTH,
  type Stage,
  type SubworkflowConfig,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from './schema.ts';
import type { ValidationIssue } from './validate.ts';

/** What the validator needs to know about a workflow a sub-workflow stage points at. */
export interface SubworkflowTarget {
  definition: WorkflowDefinition;
  /** An approved (active) version exists; the child pins that version when it is created. */
  approved: boolean;
  /** The workflow is enabled in the target project. */
  enabledInProject: boolean;
  /** The target project belongs to the same organisation. */
  sameOrg: boolean;
}

/**
 * Finds the target of a sub-workflow stage. `project` is `'same'` (the parent card's project) or `{projectId}`.
 * Returns undefined when no such workflow is known. Supplied by the caller (server: from the registry; web: from the
 * workflows list) so this stays pure.
 */
export type SubworkflowLookup = (
  workflowKey: string,
  project: SubworkflowConfig['project'],
) => SubworkflowTarget | undefined;

export type SubworkflowStage = Stage & { subworkflow: SubworkflowConfig };

export const subworkflowStages = (def: Pick<WorkflowDefinition, 'stages'>): SubworkflowStage[] =>
  def.stages.filter((s): s is SubworkflowStage => s.kind === 'subworkflow' && !!s.subworkflow);

/** Field keys a card of `def` must have filled to start working: required custom fields and the first agent stage's. */
export function requiredChildFields(def: WorkflowDefinition): string[] {
  const out = new Set(def.customFields.filter((f) => f.required).map((f) => f.key));
  for (const f of firstAgentStage(def)?.requiredFields ?? []) out.add(f);
  return [...out];
}

const TEXTUAL = new Set<FieldMeta['kind']>(['text', 'markdown', 'enum']);

/** Can a value of field kind `from` be copied into a field of kind `to`? */
export function fieldKindsCompatible(from: FieldMeta['kind'], to: FieldMeta['kind']): boolean {
  if (from === to || to === 'json') return true;
  return TEXTUAL.has(from) && TEXTUAL.has(to);
}

function literalFits(value: unknown, to: FieldMeta['kind']): boolean {
  if (value === null || value === undefined) return true;
  switch (to) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'list':
    case 'url-list':
      return Array.isArray(value);
    case 'text':
    case 'markdown':
    case 'enum':
    case 'uuid':
      return typeof value === 'string';
    default:
      return true;
  }
}

/** Longest chain of sub-workflows below `def` (0: it starts none). Cycles are reported, not followed. */
function walk(
  def: WorkflowDefinition,
  project: SubworkflowConfig['project'],
  path: string[],
  lookup: SubworkflowLookup,
  onCycle: (chain: string[], rootStage: string) => void,
  rootStage?: string,
): number {
  let deepest = 0;
  for (const s of subworkflowStages(def)) {
    const cfg = s.subworkflow;
    const here = rootStage ?? s.id;
    if (path.includes(cfg.workflowKey)) {
      onCycle([...path, cfg.workflowKey], here);
      continue;
    }
    const nextProject = cfg.project === 'same' ? project : cfg.project;
    const target = lookup(cfg.workflowKey, nextProject);
    if (!target) {
      deepest = Math.max(deepest, 1);
      continue;
    }
    deepest = Math.max(
      deepest,
      1 + walk(target.definition, nextProject, [...path, cfg.workflowKey], lookup, onCycle, here),
    );
  }
  return deepest;
}

/**
 * Rule 10, target-dependent part: the target workflow exists, is approved and enabled, no cycle through other
 * workflows' sub-workflow stages, nesting depth <= `MAX_SUBWORKFLOW_DEPTH` (root -> A -> B -> C is 3), mapped fields
 * exist with compatible types. `input` is the workflow being edited (not necessarily stored); unparsable input yields
 * no issues here (validateWorkflow reports it).
 */
export function validateSubworkflowTargets(input: unknown, lookup: SubworkflowLookup): ValidationIssue[] {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) return [];
  const def = parsed.data;
  const issues: ValidationIssue[] = [];
  const err = (code: ValidationIssue['code'], message: string, stageId: string) =>
    issues.push({ severity: 'error', rule: 10, code, message, stageId });
  const parentCatalogue = fieldCatalogue(def.fieldSet, def.customFields);

  for (const s of subworkflowStages(def)) {
    const cfg = s.subworkflow;
    if (cfg.workflowKey === def.key) {
      err('subworkflow_cycle', `stage '${s.id}' starts the workflow it belongs to`, s.id);
      continue;
    }
    const target = lookup(cfg.workflowKey, cfg.project);
    if (!target) {
      err('subworkflow_unknown_target', `stage '${s.id}' starts unknown workflow '${cfg.workflowKey}'`, s.id);
      continue;
    }
    if (!target.sameOrg)
      err('subworkflow_cross_org', `stage '${s.id}': the target project is in another organisation`, s.id);
    if (!target.approved)
      err(
        'subworkflow_target_not_approved',
        `workflow '${cfg.workflowKey}' has no approved version yet`,
        s.id,
      );
    if (!target.enabledInProject)
      err(
        'subworkflow_target_not_enabled',
        `workflow '${cfg.workflowKey}' is not enabled in the target project`,
        s.id,
      );
    const t = target.definition;
    if (cfg.cardType && !t.cardTypes.includes(cfg.cardType))
      err('subworkflow_unknown_card_type', `workflow '${t.key}' has no card type '${cfg.cardType}'`, s.id);

    const childCat = fieldCatalogue(t.fieldSet, t.customFields);
    for (const m of cfg.fieldsIn) {
      const to = childCat[m.to];
      if (!to) {
        err('subworkflow_unknown_field', `stage '${s.id}' fills unknown field '${m.to}' of '${t.key}'`, s.id);
        continue;
      }
      if ('field' in m.from) {
        const from = parentCatalogue[m.from.field];
        if (from && !fieldKindsCompatible(from.kind, to.kind))
          err(
            'subworkflow_field_type',
            `stage '${s.id}': '${m.from.field}' (${from.kind}) cannot fill '${m.to}' (${to.kind})`,
            s.id,
          );
      } else if ('template' in m.from) {
        if (!TEXTUAL.has(to.kind))
          err(
            'subworkflow_field_type',
            `stage '${s.id}': a text template cannot fill '${m.to}' (${to.kind})`,
            s.id,
          );
      } else if (!literalFits(m.from.value, to.kind)) {
        err(
          'subworkflow_field_type',
          `stage '${s.id}': the fixed value does not fit '${m.to}' (${to.kind})`,
          s.id,
        );
      }
    }
    for (const m of cfg.fieldsOut) {
      const from = childCat[m.from];
      const to = parentCatalogue[m.to];
      if (!from) {
        err(
          'subworkflow_unknown_field',
          `stage '${s.id}' copies unknown field '${m.from}' of '${t.key}'`,
          s.id,
        );
      } else if (to && !fieldKindsCompatible(from.kind, to.kind)) {
        err(
          'subworkflow_field_type',
          `stage '${s.id}': '${m.from}' (${from.kind}) cannot fill '${m.to}' (${to.kind})`,
          s.id,
        );
      }
    }
    if (cfg.start === 'queued') {
      const missing = requiredChildFields(t).filter((f) => !cfg.fieldsIn.some((m) => m.to === f));
      if (missing.length > 0)
        issues.push({
          severity: 'warning',
          rule: 0,
          code: 'subworkflow_required_unmapped',
          message: `stage '${s.id}' starts the child queued but does not fill: ${missing.join(', ')}`,
          stageId: s.id,
        });
    }
  }

  const cycles = new Map<string, string>();
  const depth = walk(def, 'same', [def.key], lookup, (chain, stageId) => {
    if (!cycles.has(stageId)) cycles.set(stageId, chain.join(' -> '));
  });
  for (const [stageId, chain] of cycles)
    if (!issues.some((i) => i.code === 'subworkflow_cycle' && i.stageId === stageId))
      err('subworkflow_cycle', `sub-workflows form a cycle: ${chain}`, stageId);
  if (depth > MAX_SUBWORKFLOW_DEPTH)
    issues.push({
      severity: 'error',
      rule: 10,
      code: 'subworkflow_too_deep',
      message: `sub-workflows are nested ${depth} levels deep (at most ${MAX_SUBWORKFLOW_DEPTH})`,
    });
  return issues;
}
