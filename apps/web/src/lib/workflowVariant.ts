import {
  BUILTIN_WORKFLOWS,
  type DefinitionIssue,
  explainIssues,
  insertedStageIds,
  investigateInsertion,
  materialiseVariant,
  NON_VARIANT_BASES,
  type OrgCatalogueResponse,
  type ProjectWorkflowDto,
  type RoleDefinition,
  type StageInsertionInput,
  uxDesignInsertion,
  type ValidationIssue,
  validateVariant,
  type WorkflowDefinition,
  type WorkflowVariantRequest,
  WorkflowVariantSpecSchema,
} from '@aom/shared';
import type { BuilderIssue } from './builder.ts';

/** An insertion as the editor keeps it (the `StageInsertionInput` the server takes). */
export type EditorInsertion = StageInsertionInput;

/** One row of the builder's step list: a stage of the base (locked) or one the project inserted. */
export interface VariantRow {
  id: string;
  label: string;
  kind: 'agent' | 'manual' | 'terminal' | 'subworkflow' | 'human' | 'server';
  claimRole: string | null;
  doneCriteria: string;
  inserted: boolean;
}

/** Lower-case id from a label: letters, digits and `_`, starting with a letter. */
export function slugId(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(s) ? s : s ? `step_${s}` : '';
}

/** True when a variant can be based on this workflow (code and approved custom workflows; never on a variant). */
export const canCustomise = (wf: Pick<ProjectWorkflowDto, 'workflowKey' | 'variantOf'>): boolean =>
  !wf.variantOf && !NON_VARIANT_BASES.includes(wf.workflowKey);

/** The suggested key and name of a project's variant of a workflow. */
export const suggestVariant = (wf: Pick<ProjectWorkflowDto, 'workflowKey' | 'name'>, projectKey: string) => ({
  key: `${wf.workflowKey}-${projectKey.toLowerCase()}`.replace(/[^a-z0-9_-]/g, ''),
  name: `${wf.name} (${projectKey})`,
});

/** The request for the variant routes (the insertions are the storage format; no full definition is sent). */
export function variantRequest(
  key: string,
  name: string,
  base: { key: string; version: number },
  insertions: EditorInsertion[],
): WorkflowVariantRequest {
  return { key, name, base, insertions } as WorkflowVariantRequest;
}

/** The exact base version a variant is authored on: the catalogue's copy, else the built-in one. */
export function findBaseDefinition(
  cat: OrgCatalogueResponse | undefined,
  key: string,
  version: number,
): WorkflowDefinition | null {
  const fromCat = cat?.workflows
    .filter((w) => w.key === key)
    .flatMap((w) => w.versions)
    .find((v) => v.version === version && (v.status === 'active' || v.status === 'superseded'));
  return fromCat?.definition ?? BUILTIN_WORKFLOWS.find((w) => w.key === key && w.version === version) ?? null;
}

interface SpecParts {
  key: string;
  name: string;
  projectId: string;
  insertions: readonly EditorInsertion[];
}

const specOf = (base: WorkflowDefinition, s: SpecParts) => ({
  key: s.key,
  name: s.name,
  projectId: s.projectId,
  base: { key: base.key, version: base.version },
  insertions: [...s.insertions],
});

/** The variant's definition (the base with the insertions applied), or null when an insertion cannot be placed. */
export function materialise(base: WorkflowDefinition, s: SpecParts): WorkflowDefinition | null {
  if (s.insertions.length === 0) return base;
  const spec = WorkflowVariantSpecSchema.safeParse(specOf(base, s));
  if (!spec.success) return null;
  try {
    return materialiseVariant(base, spec.data);
  } catch {
    return null;
  }
}

const rowOf = (
  s: {
    id: string;
    label: string;
    kind: VariantRow['kind'];
    claimRole: string | null;
    doneCriteria?: string;
  },
  inserted: boolean,
): VariantRow => ({
  id: s.id,
  label: s.label,
  kind: s.kind,
  claimRole: s.claimRole,
  doneCriteria: s.doneCriteria ?? '',
  inserted,
});

/** The steps in flow order. When the insertions cannot be placed, an inserted step follows the step it names. */
export function variantRows(
  base: WorkflowDefinition,
  def: WorkflowDefinition | null,
  insertions: readonly EditorInsertion[],
): VariantRow[] {
  const insertedIds = new Set(insertions.map((i) => i.stage.id));
  if (def) return def.stages.map((s) => rowOf(s, insertedIds.has(s.id)));
  const out = base.stages.map((s) => rowOf(s, false));
  for (const ins of insertions) {
    const at = out.findIndex((r) => r.id === ins.after);
    if (at >= 0)
      out.splice(
        at + 1,
        0,
        rowOf(
          {
            id: ins.stage.id,
            label: ins.stage.label,
            kind: ins.stage.kind === 'approval' ? 'human' : 'agent',
            claimRole: ins.stage.claimRole ?? null,
            doneCriteria: ins.stage.doneCriteria,
          },
          true,
        ),
      );
  }
  return out;
}

export interface VariantCheck {
  def: WorkflowDefinition | null;
  issues: BuilderIssue[];
  errors: number;
  warnings: number;
  /** Issues per stage id; workflow-level ones under ''. */
  byStage: Map<string, BuilderIssue[]>;
}

const asValidation = (i: DefinitionIssue): ValidationIssue => ({ rule: 0, ...i }) as ValidationIssue;

/**
 * Validates the variant in the browser with the shared `validateVariant` and words the result for the owner
 * (`explainIssues`). `server` issues, when given (the answer of the last save), replace the local ones.
 */
export function checkVariant(
  base: WorkflowDefinition,
  s: SpecParts,
  roles: readonly RoleDefinition[],
  server?: readonly DefinitionIssue[],
): VariantCheck {
  const def = materialise(base, s);
  let raw: ValidationIssue[] = [];
  if (server && server.length > 0) raw = server.map(asValidation);
  else if (s.insertions.length > 0)
    raw = validateVariant(specOf(base, s), base, roles, {
      builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key),
    }).issues;
  const issues: BuilderIssue[] = explainIssues(raw, def ?? base);
  const byStage = new Map<string, BuilderIssue[]>();
  for (const i of issues) byStage.set(i.stageId ?? '', [...(byStage.get(i.stageId ?? '') ?? []), i]);
  for (const list of byStage.values())
    list.sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
  return {
    def,
    issues,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    byStage,
  };
}

// ------------------------------------------------------------------------------------------------ edits

/** Removes an inserted step; steps inserted after it now follow what it followed. */
export function removeInsertion(insertions: readonly EditorInsertion[], stageId: string): EditorInsertion[] {
  const gone = insertions.find((i) => i.stage.id === stageId);
  if (!gone) return [...insertions];
  return insertions
    .filter((i) => i.stage.id !== stageId)
    .map((i) => (i.after === stageId ? { ...i, after: gone.after, redirect: undefined } : i));
}

/** Changes what the author controls of an inserted step (its id stays). */
export function updateInsertion(
  insertions: readonly EditorInsertion[],
  stageId: string,
  patch: { label?: string; claimRole?: string; doneCriteria?: string },
): EditorInsertion[] {
  return insertions.map((i) => (i.stage.id === stageId ? { ...i, stage: { ...i.stage, ...patch } } : i));
}

/** Whether the step at `index` of the flow can move one place (not before the first step or past the final one). */
export function canMoveInserted(rows: readonly VariantRow[], index: number, dir: -1 | 1): boolean {
  if (dir === -1) return index >= 2;
  const next = rows[index + 1];
  return !!next && next.kind !== 'terminal';
}

/**
 * Moves an inserted step one place in the flow. Every inserted step is re-anchored on the step before it, in flow
 * order, so the insertions still describe exactly this order.
 */
export function moveInsertion(
  insertions: readonly EditorInsertion[],
  rows: readonly VariantRow[],
  stageId: string,
  dir: -1 | 1,
): EditorInsertion[] {
  const at = rows.findIndex((r) => r.id === stageId);
  if (at < 0 || !canMoveInserted(rows, at, dir)) return [...insertions];
  const order = rows.map((r) => r.id);
  const other = at + dir;
  [order[at], order[other]] = [order[other] as string, order[at] as string];
  const byId = new Map(insertions.map((i) => [i.stage.id, i]));
  const out: EditorInsertion[] = [];
  order.forEach((id, p) => {
    const ins = byId.get(id);
    if (!ins) return;
    const after = order[p - 1] as string;
    out.push({ ...ins, after, redirect: after === ins.after ? ins.redirect : undefined });
  });
  return out;
}

export { insertedStageIds, investigateInsertion, uxDesignInsertion };
