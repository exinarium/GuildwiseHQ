import { columnFor, getStage, type SubworkflowsPanel } from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { iso, type Row, rows } from '../db/sql.ts';

/** The board column a card is in (the child's current column, as its own project's board shows it). */
async function columnOf(ctx: Ctx, c: Row): Promise<string | null> {
  const wf = await loadWorkflowById(ctx.pool, c.workflow_version_id);
  const stage = wf ? getStage(wf.definition, c.stage) : undefined;
  if (!stage) return null;
  return columnFor(
    {
      status: c.status,
      stage: c.stage,
      reworkRound: c.rework_round,
      cardType: c.card_type,
      finalizeState: c.finalize_state,
    },
    stage,
  );
}

export interface WaitingChild {
  id: string;
  ref: string;
  title: string | null;
  column: string | null;
  projectKey: string;
  projectName: string | null;
}

/**
 * The open child each waiting parent waits for (board chip "Waiting for SUP-12 (Translate) in project Web"). Title,
 * column and project name are given only for a child in a project the viewer is a member of.
 */
export async function waitingChildren(
  ctx: Ctx,
  userId: string,
  parentIds: string[],
): Promise<Map<string, WaitingChild>> {
  const out = new Map<string, WaitingChild>();
  if (parentIds.length === 0) return out;
  const list = await rows(
    ctx.pool,
    `SELECT r.parent_card_id, ch.*, p.key AS project_key, p.name AS project_name,
            EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ch.project_id AND pm.user_id = $2
                     AND pm.status = 'active') AS visible
       FROM subworkflow_runs r JOIN cards ch ON ch.id = r.child_card_id JOIN projects p ON p.id = ch.project_id
      WHERE r.parent_card_id = ANY($1::uuid[]) AND r.status = 'open' ORDER BY r.started_at`,
    [parentIds, userId],
  );
  for (const r of list) {
    if (out.has(r.parent_card_id)) continue;
    out.set(r.parent_card_id, {
      id: r.id,
      ref: r.ref,
      title: r.visible ? r.title : null,
      column: r.visible ? await columnOf(ctx, r) : null,
      projectKey: r.project_key,
      projectName: r.visible ? r.project_name : null,
    });
  }
  return out;
}

/** For each sub-workflow child: the parent that started it ("Started by APP-41"). */
export async function startedByMap(
  ctx: Ctx,
  childIds: string[],
): Promise<Map<string, { id: string; ref: string }>> {
  const out = new Map<string, { id: string; ref: string }>();
  if (childIds.length === 0) return out;
  for (const r of await rows(
    ctx.pool,
    `SELECT c.id AS child_id, p.id, p.ref FROM cards c JOIN cards p ON p.id = c.parent_card_id
      WHERE c.id = ANY($1::uuid[]) AND c.origin = 'subworkflow'`,
    [childIds],
  ))
    out.set(r.child_id, { id: r.id, ref: r.ref });
  return out;
}

/** Card detail: the children this card's sub-workflow steps started, and the parent that started it. */
export async function subworkflowsPanel(
  ctx: Ctx,
  userId: string,
  card: Row,
): Promise<SubworkflowsPanel | undefined> {
  const wf = await loadWorkflowById(ctx.pool, card.workflow_version_id);
  const labelOf = (key: string) => wf?.definition.stages.find((s) => s.id === key)?.label ?? key;
  const children = await rows(
    ctx.pool,
    `SELECT r.stage_id, r.mode, r.status AS run_status, r.workflow_key, r.workflow_version, r.started_at, r.resolved_at,
            r.fields AS fields_back, ch.*, p.key AS project_key, p.name AS project_name,
            EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ch.project_id AND pm.user_id = $2
                     AND pm.status = 'active') AS visible
       FROM subworkflow_runs r JOIN cards ch ON ch.id = r.child_card_id JOIN projects p ON p.id = ch.project_id
      WHERE r.parent_card_id = $1 ORDER BY r.started_at, ch.number`,
    [card.id, userId],
  );
  let startedBy: SubworkflowsPanel['startedBy'] = null;
  if (card.parent_card_id && card.origin === 'subworkflow') {
    const [r] = await rows(
      ctx.pool,
      `SELECT pc.id, pc.ref, pc.title, pc.workflow_version_id, pr.stage_id, pj.key AS project_key,
              EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = pc.project_id AND pm.user_id = $2
                       AND pm.status = 'active') AS visible
         FROM cards pc JOIN projects pj ON pj.id = pc.project_id
         LEFT JOIN subworkflow_runs pr ON pr.parent_card_id = pc.id AND pr.child_card_id = $3
        WHERE pc.id = $1`,
      [card.parent_card_id, userId, card.id],
    );
    if (r) {
      const pwf = await loadWorkflowById(ctx.pool, r.workflow_version_id);
      startedBy = {
        id: r.id,
        ref: r.ref,
        title: r.visible ? r.title : '',
        stageLabel: pwf?.definition.stages.find((s) => s.id === r.stage_id)?.label ?? r.stage_id ?? '',
        projectKey: r.project_key,
        visible: !!r.visible,
      };
    }
  }
  if (children.length === 0 && !startedBy) return undefined;
  return {
    startedBy,
    children: await Promise.all(
      children.map(async (r) => ({
        stageId: r.stage_id as string,
        stageLabel: labelOf(r.stage_id),
        mode: r.mode,
        state: r.run_status,
        workflowKey: r.workflow_key as string,
        workflowVersion: r.workflow_version as number,
        startedAt: iso(r.started_at) as string,
        resolvedAt: iso(r.resolved_at),
        fieldsBack: (r.fields_back ?? {}) as Record<string, unknown>,
        child: {
          id: r.id as string,
          ref: r.ref as string,
          title: r.visible ? (r.title as string) : '',
          status: r.status,
          stage: r.stage as string,
          column: r.visible ? await columnOf(ctx, r) : null,
          projectId: r.project_id as string,
          projectKey: r.project_key as string,
          projectName: r.project_name as string,
          visible: !!r.visible,
          fields: r.visible ? ((r.fields ?? {}) as Record<string, unknown>) : {},
        },
      })),
    ),
  };
}
