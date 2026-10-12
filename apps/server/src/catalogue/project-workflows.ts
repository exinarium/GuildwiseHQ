import { CROSS_PROJECT_CARD_TYPES } from '@aom/shared';
import { type Queryable, type Row, rows } from '../db/sql.ts';
import { badRequest } from '../errors.ts';
import { resolveWorkflow, type WorkflowVersionRow } from './loader.ts';

/** Built-in workflows a project cannot enable next to its own: internal (bug children) or special (feed, research). */
export const NOT_ENABLEABLE_WORKFLOWS: readonly string[] = ['code-bugfix', 'feed', 'research'];

export interface EnabledWorkflow {
  workflowKey: string;
  isPrimary: boolean;
  defaultCardTypes: string[];
}

/** The workflows a project has enabled, the primary first (docs/design/architect-and-workflows.md 4.1). */
export async function enabledWorkflows(db: Queryable, project: Row): Promise<EnabledWorkflow[]> {
  const list = await rows(
    db,
    `SELECT workflow_key, is_primary, default_card_types FROM project_workflows
      WHERE project_id=$1 ORDER BY is_primary DESC, enabled_at, workflow_key`,
    [project.id],
  );
  const out: EnabledWorkflow[] = list.map((r) => ({
    workflowKey: r.workflow_key,
    isPrimary: r.is_primary,
    defaultCardTypes: r.default_card_types ?? [],
  }));
  // Defensive: a project row without its primary entry (cannot happen after migration 1660) still has its workflow.
  if (!out.some((e) => e.isPrimary))
    out.unshift({ workflowKey: project.workflow_key, isPrimary: true, defaultCardTypes: [] });
  return out;
}

/**
 * The workflow that runs a card of this type in this project. With an explicit `workflowKey` it must be enabled on the
 * project (or be the cross-project workflow of the type): 400 `workflow_not_enabled` otherwise; `null` when that
 * workflow does not run the type. Without a key: an enabled workflow that lists the type as its default, else the
 * primary when it runs the type, else any enabled one that does (first enabled), else the cross-project workflow
 * (`CROSS_PROJECT_CARD_TYPES`, a research card in a code project), else `null`.
 * Project variants resolve for their own project only.
 */
export async function resolveProjectCardWorkflow(
  db: Queryable,
  project: Row,
  cardType: string,
  workflowKey?: string,
): Promise<WorkflowVersionRow | null> {
  const enabled = await enabledWorkflows(db, project);
  const open = (key: string) => resolveWorkflow(db, project.org_id, key, project.id);
  const runs = (wf: WorkflowVersionRow | null): wf is WorkflowVersionRow =>
    !!wf && wf.definition.cardTypes.includes(cardType as never);
  const cross = CROSS_PROJECT_CARD_TYPES[cardType];

  if (workflowKey) {
    if (enabled.some((e) => e.workflowKey === workflowKey)) {
      const wf = await open(workflowKey);
      return runs(wf) ? wf : null;
    }
    if (cross === workflowKey) {
      const wf = await resolveWorkflow(db, project.org_id, workflowKey);
      return runs(wf) ? wf : null;
    }
    throw badRequest('workflow_not_enabled', `workflow '${workflowKey}' is not enabled on this project`);
  }

  const ordered = [
    ...enabled.filter((e) => e.defaultCardTypes.includes(cardType)),
    ...enabled.filter((e) => e.isPrimary && !e.defaultCardTypes.includes(cardType)),
    ...enabled.filter((e) => !e.isPrimary && !e.defaultCardTypes.includes(cardType)),
  ];
  for (const e of ordered) {
    const wf = await open(e.workflowKey);
    if (runs(wf)) return wf;
  }
  if (!cross || enabled.some((e) => e.workflowKey === cross)) return null;
  const wf = await resolveWorkflow(db, project.org_id, cross);
  return runs(wf) ? wf : null;
}
