import { type WorkflowDefinition, type WorkflowDefinitionInput, WorkflowDefinitionSchema } from './schema.ts';

/** Step-level comparison of two versions of a workflow ("Compare with previous", docs/design/workflow-builder.md 2.5). */

export interface RouteChange {
  outcomeId: string;
  change: 'added' | 'removed' | 'changed';
  /** Property names that differ (changed only): to, label, kind, event, rework, when, ... */
  props: string[];
}

export interface StageDiff {
  stageId: string;
  label: string;
  change: 'added' | 'removed' | 'changed';
  /** Stage properties that differ (changed only), outcomes excluded. */
  props: string[];
  routes: RouteChange[];
}

export interface DefinitionDiff {
  stages: StageDiff[];
  /** Stage ids whose position among the shared stages changed. */
  moved: string[];
  fieldsAdded: string[];
  fieldsRemoved: string[];
  fieldsChanged: string[];
  /** Workflow-level properties that differ: name, department, cardTypes, initialStage, fieldSet. */
  meta: string[];
  identical: boolean;
}

const norm = (v: unknown): string => JSON.stringify(v, (_k, x) => sortKeys(x));
function sortKeys(x: unknown): unknown {
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }
  return x;
}
const same = (a: unknown, b: unknown): boolean => norm(a) === norm(b);

function parse(d: WorkflowDefinitionInput | WorkflowDefinition): WorkflowDefinition {
  const r = WorkflowDefinitionSchema.safeParse(d);
  return r.success ? r.data : (d as WorkflowDefinition);
}

function diffProps(a: object, b: object, skip: readonly string[]): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (skip.includes(k)) continue;
    if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) out.push(k);
  }
  return out.sort();
}

export function diffDefinitions(
  previous: WorkflowDefinitionInput | WorkflowDefinition,
  next: WorkflowDefinitionInput | WorkflowDefinition,
): DefinitionDiff {
  const a = parse(previous);
  const b = parse(next);
  const stages: StageDiff[] = [];
  const aById = new Map(a.stages.map((s) => [s.id, s]));
  const bById = new Map(b.stages.map((s) => [s.id, s]));
  for (const s of a.stages) {
    if (!bById.has(s.id))
      stages.push({ stageId: s.id, label: s.label, change: 'removed', props: [], routes: [] });
  }
  for (const s of b.stages) {
    const old = aById.get(s.id);
    if (!old) {
      stages.push({ stageId: s.id, label: s.label, change: 'added', props: [], routes: [] });
      continue;
    }
    const props = diffProps(old, s, ['outcomes']);
    const routes: RouteChange[] = [];
    const oldO = new Map((old.outcomes ?? []).map((o) => [o.id, o]));
    const newO = new Map((s.outcomes ?? []).map((o) => [o.id, o]));
    for (const [id] of oldO) if (!newO.has(id)) routes.push({ outcomeId: id, change: 'removed', props: [] });
    for (const [id, o] of newO) {
      const prev = oldO.get(id);
      if (!prev) routes.push({ outcomeId: id, change: 'added', props: [] });
      else {
        const p = diffProps(prev, o, []);
        if (p.length > 0) routes.push({ outcomeId: id, change: 'changed', props: p });
      }
    }
    if (props.length > 0 || routes.length > 0)
      stages.push({ stageId: s.id, label: s.label, change: 'changed', props, routes });
  }

  const sharedA = a.stages.filter((s) => bById.has(s.id)).map((s) => s.id);
  const sharedB = b.stages.filter((s) => aById.has(s.id)).map((s) => s.id);
  const moved = sharedB.filter((id, i) => sharedA[i] !== id);

  const aF = new Map(a.customFields.map((f) => [f.key, f]));
  const bF = new Map(b.customFields.map((f) => [f.key, f]));
  const fieldsAdded = [...bF.keys()].filter((k) => !aF.has(k));
  const fieldsRemoved = [...aF.keys()].filter((k) => !bF.has(k));
  const fieldsChanged = [...bF.keys()].filter((k) => aF.has(k) && !same(aF.get(k), bF.get(k)));

  const meta = (['name', 'department', 'fieldSet', 'cardTypes', 'initialStage'] as const).filter(
    (k) => !same(a[k], b[k]),
  );
  return {
    stages,
    moved,
    fieldsAdded,
    fieldsRemoved,
    fieldsChanged,
    meta,
    identical:
      stages.length === 0 &&
      moved.length === 0 &&
      fieldsAdded.length + fieldsRemoved.length + fieldsChanged.length === 0 &&
      meta.length === 0,
  };
}

/** Plain-language lines for a diff ("Added step 'Check'", "Changed step 'Write': role, doneCriteria"). */
export function describeDiff(diff: DefinitionDiff): string[] {
  const lines: string[] = [];
  for (const s of diff.stages) {
    if (s.change === 'added') lines.push(`Added step '${s.label}'`);
    else if (s.change === 'removed') lines.push(`Removed step '${s.label}'`);
    else {
      const parts = [...s.props];
      for (const r of s.routes) parts.push(`route ${r.outcomeId} ${r.change}`);
      lines.push(`Changed step '${s.label}': ${parts.join(', ')}`);
    }
  }
  for (const id of diff.moved) lines.push(`Moved step '${id}'`);
  for (const k of diff.fieldsAdded) lines.push(`Added field '${k}'`);
  for (const k of diff.fieldsRemoved) lines.push(`Removed field '${k}'`);
  for (const k of diff.fieldsChanged) lines.push(`Changed field '${k}'`);
  for (const k of diff.meta) lines.push(`Changed ${k}`);
  return lines;
}
