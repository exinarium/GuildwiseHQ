import {
  canConvertProject,
  insertedStageIds,
  LEGACY_CODE_V6_KEY,
  type ProjectWorkflowDto,
  type ProjectWorkflowsResponse,
  type SetProjectWorkflowsRequest,
  streamId,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  type WorkflowVariantSpec,
  WorkflowVariantSpecSchema,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import { enabledWorkflows, NOT_ENABLEABLE_WORKFLOWS } from '../catalogue/project-workflows.ts';
import type { Ctx } from '../context.ts';
import { type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden } from '../errors.ts';
import { projectScope, userActor } from './common.ts';

/** Who may enable workflows and create variants: the organization's Owner and Admins (same as converting a project). */
export async function assertCanEditWorkflows(db: Queryable, userId: string, project: Row): Promise<void> {
  if (!canConvertProject({ orgRole: await orgRoleOf(db, userId, project.org_id) }))
    throw forbidden('only the organization Owner and Admins can enable workflows and create variants');
}

const stageList = (def: WorkflowDefinition, spec: WorkflowVariantSpec | null) => {
  const inserted = new Set(spec ? insertedStageIds(spec) : []);
  return def.stages.map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    claimRole: s.claimRole,
    inherited: !inserted.has(s.id),
  }));
};

/** The project's workflows: those enabled (primary first) and the ones that could be, with variants and their state. */
export async function projectWorkflowsView(
  ctx: Ctx,
  userId: string,
  projectId: string,
): Promise<ProjectWorkflowsResponse> {
  const project = await loadVisibleProject(ctx.pool, userId, projectId);
  const canEdit = canConvertProject({ orgRole: await orgRoleOf(ctx.pool, userId, project.org_id) });
  const enabled = await enabledWorkflows(ctx.pool, project);
  const open = new Map(
    (
      await rows<{ key: string; n: number }>(
        ctx.pool,
        `SELECT w.key, count(*)::int AS n FROM cards c JOIN workflow_versions w ON w.id = c.workflow_version_id
          WHERE c.project_id=$1 AND c.status NOT IN ('done','cancelled') GROUP BY w.key`,
        [projectId],
      )
    ).map((r) => [r.key, Number(r.n)]),
  );

  // Newest active version of every workflow the project could use, and every variant of its own.
  const wfRows = await rows(
    ctx.pool,
    `SELECT id, org_id, key, version, status, definition, project_id, desk_item_id, variant_spec, base_version
       FROM workflow_versions
      WHERE (org_id IS NULL OR org_id = $1) AND (project_id IS NULL OR project_id = $2)
        AND status IN ('active','draft','pending_approval') AND key <> '${LEGACY_CODE_V6_KEY}'
      ORDER BY (org_id IS NULL), key, version DESC`,
    [project.org_id, projectId],
  );
  const keys = [...new Set(wfRows.map((r) => r.key as string))];
  const dtos: ProjectWorkflowDto[] = [];
  for (const key of keys) {
    const versions = wfRows.filter((r) => r.key === key);
    const isVariant = versions.some((r) => r.project_id);
    const active = versions.find((r) => r.status === 'active');
    const pendingRow = isVariant ? versions.find((r) => r.status !== 'active') : undefined;
    const pending = pendingRow && (!active || pendingRow.version > active.version) ? pendingRow : undefined;
    const shown = active ?? pending;
    if (!shown) continue;
    const entry = enabled.find((e) => e.workflowKey === key);
    if (!entry && NOT_ENABLEABLE_WORKFLOWS.includes(key)) continue;
    // Non-variants need an active version to be offered at all.
    if (!isVariant && !active) continue;
    const def = WorkflowDefinitionSchema.parse(shown.definition);
    const spec = shown.variant_spec ? WorkflowVariantSpecSchema.safeParse(shown.variant_spec) : undefined;
    const specData = spec?.success ? spec.data : null;
    let baseUpdate: ProjectWorkflowDto['baseUpdate'] = null;
    if (def.extends) {
      const latest = await resolveWorkflow(ctx.pool, project.org_id, def.extends.key);
      if (latest && latest.version > def.extends.version) baseUpdate = { version: latest.version };
    }
    dtos.push({
      workflowKey: key,
      name: def.name,
      version: shown.version,
      versionId: shown.id,
      isPrimary: entry?.isPrimary ?? false,
      enabled: !!entry,
      defaultCardTypes: entry?.defaultCardTypes ?? [],
      cardTypes: def.cardTypes,
      variantOf: def.extends ? { key: def.extends.key, version: def.extends.version } : null,
      baseUpdate,
      pendingVersion: pending
        ? {
            id: pending.id,
            version: pending.version,
            status: pending.status,
            deskItemId: pending.desk_item_id ?? null,
            variantSpec: (() => {
              const s = WorkflowVariantSpecSchema.safeParse(pending.variant_spec);
              return s.success ? s.data : null;
            })(),
          }
        : null,
      variantSpec: specData,
      stages: stageList(def, specData),
      openCards: open.get(key) ?? 0,
    });
  }
  // A variant that only has a pending version cannot be enabled yet; it is listed as available.
  const byKey = new Map(dtos.map((d) => [d.workflowKey, d]));
  const enabledDtos = enabled.flatMap((e) => byKey.get(e.workflowKey) ?? []);
  const availableDtos = dtos.filter((d) => !d.enabled);
  return { enabled: enabledDtos, available: availableDtos, canEdit };
}

/**
 * Sets the full set of enabled workflows (Owner and Admins). The primary workflow always stays enabled. Disabling a
 * workflow with open cards is allowed: those cards finish on the version they pinned.
 */
export async function setProjectWorkflows(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: SetProjectWorkflowsRequest,
): Promise<ProjectWorkflowsResponse> {
  await withAppendTx(ctx.pool, async (tx) => {
    const project = await loadVisibleProject(tx, user.id, projectId);
    await assertCanEditWorkflows(tx, user.id, project);
    if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
    const current = await enabledWorkflows(tx, project);
    const primary = current.find((e) => e.isPrimary);
    const primaryKey = (primary?.workflowKey ?? project.workflow_key) as string;
    if (
      NOT_ENABLEABLE_WORKFLOWS.includes(primaryKey) &&
      req.enabled.some((e) => e.workflowKey !== primaryKey)
    )
      throw badRequest(
        'single_workflow_project',
        `a ${primaryKey} project runs one workflow: convert it first to enable others`,
      );
    const seen = new Set<string>();
    const entries: Array<{ workflowKey: string; defaultCardTypes: string[] }> = [];
    for (const e of req.enabled) {
      if (seen.has(e.workflowKey))
        throw badRequest('duplicate_workflow', `'${e.workflowKey}' is listed twice`);
      seen.add(e.workflowKey);
      if (e.workflowKey !== primaryKey && NOT_ENABLEABLE_WORKFLOWS.includes(e.workflowKey))
        throw badRequest(
          'workflow_not_available',
          `the ${e.workflowKey} workflow cannot be enabled on a project`,
        );
      const wf = await resolveWorkflow(tx, project.org_id, e.workflowKey, projectId);
      if (!wf)
        throw badRequest('unknown_workflow', `workflow '${e.workflowKey}' does not exist or is not approved`);
      for (const t of e.defaultCardTypes)
        if (!wf.definition.cardTypes.includes(t as never))
          throw badRequest(
            'invalid_default_card_type',
            `workflow '${e.workflowKey}' does not run '${t}' cards`,
          );
      entries.push({ workflowKey: e.workflowKey, defaultCardTypes: [...new Set(e.defaultCardTypes)] });
    }
    if (!seen.has(primaryKey))
      entries.unshift({ workflowKey: primaryKey, defaultCardTypes: primary?.defaultCardTypes ?? [] });
    const claimed = new Map<string, string>();
    for (const e of entries)
      for (const t of e.defaultCardTypes) {
        const other = claimed.get(t);
        if (other)
          throw badRequest(
            'duplicate_default',
            `'${t}' cards cannot default to both '${other}' and '${e.workflowKey}'`,
          );
        claimed.set(t, e.workflowKey);
      }
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectWorkflowsSet', payload: { projectId, enabled: entries, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(project.org_id, projectId),
        },
      ],
      { tx },
    );
  });
  return projectWorkflowsView(ctx, user.id, projectId);
}
