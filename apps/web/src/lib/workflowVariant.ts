import {
  insertedStageIds,
  investigateInsertion,
  NON_VARIANT_BASES,
  type ProjectWorkflowDto,
  type StageInsertionInput,
  type WorkflowVariantRequest,
} from '@aom/shared';

/** One row of the editor's vertical list: a stage of the base (read-only) or one the project inserted. */
export interface EditorStage {
  id: string;
  label: string;
  kind: 'agent' | 'manual' | 'terminal' | 'subworkflow';
  claimRole: string | null;
  inserted: boolean;
}

/** An insertion as the editor keeps it (the `StageInsertionInput` the server takes). */
export type EditorInsertion = StageInsertionInput;

/** Lower-case id from a label: letters, digits and `_`, starting with a letter. */
export function slugId(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(s) ? s : s ? `step_${s}` : '';
}

/** The stages the base workflow has, without any step this project inserted (the read-only part of the list). */
export function baseStagesOf(wf: Pick<ProjectWorkflowDto, 'stages'>): EditorStage[] {
  return wf.stages
    .filter((s) => s.inherited)
    .map((s) => ({ id: s.id, label: s.label, kind: s.kind, claimRole: s.claimRole, inserted: false }));
}

/** Places each insertion after the stage it names (insertions after an earlier insertion nest behind it). */
export function orderStages(base: EditorStage[], insertions: EditorInsertion[]): EditorStage[] {
  const out = [...base];
  for (const ins of insertions) {
    const at = out.findIndex((s) => s.id === ins.after);
    const stage: EditorStage = {
      id: ins.stage.id,
      label: ins.stage.label,
      kind: 'agent',
      claimRole: ins.stage.claimRole,
      inserted: true,
    };
    if (at >= 0) out.splice(at + 1, 0, stage);
  }
  return out;
}

/** True when a variant can be based on this workflow (code and approved custom workflows; never on a variant). */
export const canCustomise = (wf: Pick<ProjectWorkflowDto, 'workflowKey' | 'variantOf'>): boolean =>
  !wf.variantOf && !NON_VARIANT_BASES.includes(wf.workflowKey);

/** The suggested key and name of a project's variant of a workflow. */
export const suggestVariant = (wf: Pick<ProjectWorkflowDto, 'workflowKey' | 'name'>, projectKey: string) => ({
  key: `${wf.workflowKey}-${projectKey.toLowerCase()}`.replace(/[^a-z0-9_-]/g, ''),
  name: `${wf.name} (${projectKey})`,
});

/** The request for the variant routes. */
export function variantRequest(
  key: string,
  name: string,
  base: { key: string; version: number },
  insertions: EditorInsertion[],
): WorkflowVariantRequest {
  return { key, name, base, insertions } as WorkflowVariantRequest;
}

export { insertedStageIds, investigateInsertion };
