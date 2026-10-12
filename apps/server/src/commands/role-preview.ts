import {
  GENERIC_PREVIEW_STAGE,
  type PreviewStage,
  RoleDefinitionSchema,
  type RoleDraftInput,
  type RolePreviewResponse,
  renderRolePreview,
  type Seniority,
  type Stage,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
} from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';
import { badRequest, notFound } from '../errors.ts';

export interface RolePreviewOptions {
  workflowKey?: string | undefined;
  stageId?: string | undefined;
  seniority?: Seniority | undefined;
}

/** A believable value for a custom card field, so the sample card shows what the workflow's cards carry. */
function sampleValue(f: WorkflowDefinition['customFields'][number]): unknown {
  switch (f.type) {
    case 'number':
      return 3;
    case 'boolean':
      return true;
    case 'list':
    case 'url-list':
      return f.type === 'list' ? ['First item', 'Second item'] : ['https://example.com/one'];
    default:
      return `Sample ${f.label.toLowerCase()}`;
  }
}

/** The newest custom (organization level, not a project variant) workflow with this key, drafts included. */
async function customWorkflow(db: Queryable, orgId: string, key: string): Promise<WorkflowDefinition> {
  const row = await one(
    db,
    `SELECT definition FROM workflow_versions
      WHERE org_id=$1 AND key=$2 AND project_id IS NULL AND status IN ('active','draft','pending_approval')
      ORDER BY (status='active') DESC, version DESC LIMIT 1`,
    [orgId, key],
  );
  if (!row) throw notFound(`custom workflow '${key}' not found`);
  return WorkflowDefinitionSchema.parse(row.definition);
}

function previewStage(def: WorkflowDefinition, stage: Stage): PreviewStage {
  return {
    workflowKey: def.key,
    stageId: stage.id,
    stageLabel: stage.label,
    doneCriteria: stage.doneCriteria || 'The work for this step is complete.',
    outcomes: stage.outcomes.map((o) => ({ id: o.id, label: o.label, kind: o.kind, data: o.data })),
    maxShiftMinutes: stage.maxShiftMinutes,
    fields: Object.fromEntries(def.customFields.map((f) => [f.key, sampleValue(f)])),
  };
}

/**
 * Renders the instructions a role would get on a sample shift (`renderInstructions` with a synthetic brief). Nothing
 * runs and nothing is stored. With `workflowKey` and `stageId` the sample shift is that step of a custom workflow.
 */
export async function previewRole(
  db: Queryable,
  orgId: string,
  role: RoleDraftInput,
  opts: RolePreviewOptions = {},
): Promise<RolePreviewResponse> {
  let stage: PreviewStage | undefined;
  if (opts.stageId && !opts.workflowKey) throw badRequest('invalid_preview', 'name the workflow of the step');
  if (opts.workflowKey) {
    const def = await customWorkflow(db, orgId, opts.workflowKey);
    const s = opts.stageId
      ? def.stages.find((x) => x.id === opts.stageId)
      : (def.stages.find((x) => x.kind === 'agent' && x.claimRole === role.key) ??
        def.stages.find((x) => x.kind === 'agent'));
    if (!s) throw notFound(`step '${opts.stageId ?? ''}' not found in '${def.key}'`);
    if (s.kind !== 'agent')
      throw badRequest('invalid_preview', `'${s.label}' is not a step an agent works on`);
    stage = previewStage(def, s);
  }
  const text = renderRolePreview(role, stage ?? GENERIC_PREVIEW_STAGE, opts.seniority);
  const headings = text
    .split('\n')
    .filter((l) => l.startsWith('# '))
    .map((l) => l.slice(2).trim());
  return {
    text,
    stage: stage?.workflowKey
      ? { workflowKey: stage.workflowKey, stageId: stage.stageId, stageLabel: stage.stageLabel }
      : null,
    headings,
  };
}

/** The same preview for a stored role draft or version of the organization (the stored definition is rendered). */
export async function previewRoleDraft(
  db: Queryable,
  orgId: string,
  id: string,
  opts: RolePreviewOptions = {},
): Promise<RolePreviewResponse> {
  const row = await one(db, 'SELECT org_id, definition FROM role_definitions WHERE id=$1', [id]);
  if (!row || row.org_id !== orgId) throw notFound('role not found');
  const def = RoleDefinitionSchema.parse(row.definition);
  return previewRole(db, orgId, def, opts);
}
