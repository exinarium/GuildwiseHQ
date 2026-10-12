import { randomUUID } from 'node:crypto';
import {
  type DefinitionIssue,
  streamId,
  type VariantDraftResponse,
  validateVariant,
  type WorkflowVariantSpec,
  WorkflowVariantSpecSchema,
} from '@aom/shared';
import { resolveWorkflow } from '../catalogue/loader.ts';
import { subworkflowLookupFor } from '../catalogue/subworkflow-lookup.ts';
import { loadBaseVersion } from '../catalogue/variants.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope } from './common.ts';
import {
  actorOf,
  authorOf,
  BUILTIN_WORKFLOW_KEYS,
  type Designer,
  nextVersion,
  roleCatalogue,
} from './designer.ts';

/**
 * Project workflow variants (docs/design/architect-and-workflows.md 4.2): a draft is the insertions on a base workflow
 * version, stored materialised as a `workflow_versions` row with `project_id` set. Submit, approve and discard are the
 * custom-workflow flow (`designer.ts`); only Owner and Admins reach this (checked by the caller).
 */

const issueMessage = (issues: DefinitionIssue[]) =>
  (issues.find((i) => i.severity === 'error') ?? issues[0])?.message ?? 'invalid variant';

/**
 * Saves a variant draft: a new version of `spec.key`, or (with `id`, or `upsert` when the key has an open draft) a
 * change to the open draft. Drafts may carry issues (shown inline, they block submission); a draft whose insertions
 * cannot be placed at all is refused (422).
 */
export async function saveVariantDraft(
  ctx: Ctx,
  designer: Designer,
  orgId: string,
  specInput: WorkflowVariantSpec,
  opts: { id?: string; upsert?: boolean } = {},
): Promise<VariantDraftResponse> {
  const parsed = WorkflowVariantSpecSchema.safeParse(specInput);
  if (!parsed.success)
    throw unprocessable(
      'invalid_definition',
      `the variant is not valid: ${parsed.error.issues[0]?.message}`,
      {
        issues: parsed.error.issues.map((i) => ({
          severity: 'error',
          code: 'invalid_schema',
          message: `${i.path.join('.') || '(root)'}: ${i.message}`,
        })),
      },
    );
  const spec = parsed.data;
  return withAppendTx(ctx.pool, async (tx) => {
    const project = await one(tx, 'SELECT id, status FROM projects WHERE id=$1 AND org_id=$2', [
      spec.projectId,
      orgId,
    ]);
    if (!project) throw notFound('project not found');
    if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
    if (BUILTIN_WORKFLOW_KEYS.includes(spec.key))
      throw conflict('builtin_protected', `'${spec.key}' is a built-in workflow: pick another key`);
    const taken = await one(
      tx,
      `SELECT 1 AS x FROM workflow_versions WHERE org_id=$1 AND key=$2 AND project_id IS DISTINCT FROM $3::uuid LIMIT 1`,
      [orgId, spec.key, spec.projectId],
    );
    if (taken)
      throw conflict('key_taken', `the workflow key '${spec.key}' is already used in this organization`);

    let existing = opts.id
      ? await one(
          tx,
          'SELECT * FROM workflow_versions WHERE id=$1 AND org_id=$2 AND project_id=$3 FOR UPDATE',
          [opts.id, orgId, spec.projectId],
        )
      : await one(
          tx,
          `SELECT * FROM workflow_versions WHERE org_id=$1 AND key=$2 AND project_id=$3
              AND status IN ('draft','pending_approval') ORDER BY version DESC LIMIT 1 FOR UPDATE`,
          [orgId, spec.key, spec.projectId],
        );
    if (opts.id && !existing) throw notFound('variant draft not found');
    if (existing && opts.id && existing.key !== spec.key)
      throw badRequest('key_immutable', 'the key of a draft cannot change: draft a new variant instead');
    if (existing && existing.status === 'pending_approval')
      throw conflict('pending_approval', `'${spec.key}' v${existing.version} waits for approval on the desk`);
    if (existing && !opts.id && !opts.upsert)
      throw conflict('draft_exists', `'${spec.key}' already has an open draft`, { id: existing.id });
    if (existing && existing.status !== 'draft') existing = undefined;

    const base = await loadBaseVersion(tx, orgId, spec.base.key, spec.base.version);
    if (!base)
      throw badRequest(
        'unknown_base',
        `the base workflow ${spec.base.key} v${spec.base.version} does not exist`,
      );
    const version = existing ? existing.version : await nextVersion(tx, 'workflow_versions', orgId, spec.key);
    const roles = await roleCatalogue(tx, orgId, true);
    const v = validateVariant(
      spec,
      base.definition,
      roles,
      {
        builtinWorkflowKeys: BUILTIN_WORKFLOW_KEYS,
        subworkflowLookup: await subworkflowLookupFor(tx, orgId, base.definition, spec.projectId),
      },
      { version },
    );
    const issues: DefinitionIssue[] = v.issues.map((i) => ({ ...i }));
    if (!v.definition)
      throw unprocessable('invalid_definition', `the variant is not valid: ${issueMessage(issues)}`, {
        issues,
      });
    const def = v.definition;
    const id = (existing?.id as string | undefined) ?? randomUUID();
    const ev: AppendInput = existing
      ? {
          streamId: streamId.workflow(orgId, def.key),
          event: {
            type: 'WorkflowDraftUpdated',
            payload: {
              workflowVersionId: id,
              name: def.name,
              department: def.department,
              definition: def,
              variantSpec: spec,
            },
          },
          actor: actorOf(designer),
          scope: orgScope(orgId),
        }
      : {
          streamId: streamId.workflow(orgId, def.key),
          event: {
            type: 'WorkflowVersionRegistered',
            payload: {
              workflowVersionId: id,
              orgId,
              key: def.key,
              version,
              name: def.name,
              department: def.department,
              definition: def,
              status: 'draft',
              draftedBy: authorOf(designer),
              projectId: spec.projectId,
              variantSpec: spec,
            },
          },
          actor: actorOf(designer),
          scope: orgScope(orgId),
        };
    await ctx.store.append([ev], { tx });
    const inserted = new Set(spec.insertions.map((i) => i.stage.id));
    return {
      id,
      key: def.key,
      version,
      status: 'draft' as const,
      issues,
      stages: def.stages.map((s) => ({ id: s.id, label: s.label, inherited: !inserted.has(s.id) })),
    };
  });
}

/**
 * Re-materialises a variant's insertions on the newest version of its base, as a new draft version. Insertions whose
 * `after` stage no longer exists come back as a 422 with the validation issues. 409 `already_current` when the variant
 * already sits on the newest base, `draft_exists` when a draft is open.
 */
export async function rebaseVariant(
  ctx: Ctx,
  designer: Designer,
  orgId: string,
  projectId: string,
  versionId: string,
): Promise<VariantDraftResponse> {
  const row = await one(
    ctx.pool,
    'SELECT * FROM workflow_versions WHERE id=$1 AND org_id=$2 AND project_id=$3',
    [versionId, orgId, projectId],
  );
  if (!row) throw notFound('variant not found');
  const spec = WorkflowVariantSpecSchema.safeParse(row.variant_spec);
  if (!spec.success) throw badRequest('not_a_variant', 'this workflow has no insertions to rebase');
  const latest = await resolveWorkflow(ctx.pool, orgId, spec.data.base.key);
  if (!latest) throw notFound(`base workflow ${spec.data.base.key} not found`);
  if (latest.version <= spec.data.base.version)
    throw conflict(
      'already_current',
      `the variant already sits on the newest ${latest.key} (v${latest.version})`,
    );
  return saveVariantDraft(ctx, designer, orgId, {
    ...spec.data,
    base: { key: latest.key, version: latest.version },
  });
}
