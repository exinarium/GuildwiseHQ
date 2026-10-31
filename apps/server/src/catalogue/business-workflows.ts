import { randomUUID } from 'node:crypto';
import {
  BUILTIN_WORKFLOWS,
  BUSINESS_CARD_TYPES,
  BUSINESS_ROLES,
  BUSINESS_WORKFLOW_KEY,
  BUSINESS_WORKFLOWS,
  streamId,
  validateCustomWorkflow,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';

const BUILTIN_KEYS = BUILTIN_WORKFLOWS.map((w) => w.key);

/**
 * The events that register the shipped business workflows an organization does not have yet. A definition is validated
 * first and skipped (and logged) when invalid; an existing key (edited by the owner, or made by hand) is never overwritten.
 */
export async function businessWorkflowEvents(ctx: Ctx, tx: Tx, orgId: string): Promise<AppendInput[]> {
  const have = new Set(
    (
      await rows<{ key: string }>(tx, 'SELECT DISTINCT key FROM workflow_versions WHERE org_id=$1', [orgId])
    ).map((r) => r.key),
  );
  const events: AppendInput[] = [];
  for (const def of BUSINESS_WORKFLOWS) {
    if (have.has(def.key)) continue;
    const errors = validateCustomWorkflow(def, BUSINESS_ROLES, {
      builtinWorkflowKeys: BUILTIN_KEYS,
      departments: [],
    }).filter((i) => i.severity === 'error');
    if (errors.length) {
      ctx.log.warn({ key: def.key, codes: errors.map((e) => e.code) }, 'business workflow is invalid: skipped');
      continue;
    }
    events.push({
      streamId: streamId.workflow(orgId, def.key),
      event: {
        type: 'WorkflowVersionRegistered',
        payload: {
          workflowVersionId: randomUUID(),
          orgId,
          key: def.key,
          version: def.version,
          name: def.name,
          definition: def,
          status: 'active',
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    });
  }
  return events;
}

/**
 * Registers the business workflows an organization is missing and enables each on its projects (the primary stays the
 * primary; every enabled entry is kept). Idempotent. Only for business organizations.
 */
export async function ensureBusinessWorkflows(ctx: Ctx, tx: Tx, orgId: string): Promise<void> {
  const events = await businessWorkflowEvents(ctx, tx, orgId);
  if (events.length) await ctx.store.append(events, { tx });

  const installed = new Set(
    (
      await rows<{ key: string }>(
        tx,
        `SELECT DISTINCT key FROM workflow_versions WHERE org_id=$1 AND status='active' AND project_id IS NULL`,
        [orgId],
      )
    ).map((r) => r.key),
  );
  const wanted = BUSINESS_CARD_TYPES.map((t) => ({ type: t, key: BUSINESS_WORKFLOW_KEY[t] })).filter((w) =>
    installed.has(w.key),
  );
  if (!wanted.length) return;
  const projects = await rows<{ id: string; created_by: string }>(
    tx,
    `SELECT id, created_by FROM projects WHERE org_id=$1 AND kind='project' AND status='active' ORDER BY id`,
    [orgId],
  );
  for (const p of projects) {
    const enabled = await rows<{ workflow_key: string; default_card_types: string[] | null }>(
      tx,
      `SELECT workflow_key, default_card_types FROM project_workflows WHERE project_id=$1
        ORDER BY is_primary DESC, enabled_at, workflow_key`,
      [p.id],
    );
    const have = new Set(enabled.map((e) => e.workflow_key));
    const missing = wanted.filter((w) => !have.has(w.key));
    if (!missing.length) continue;
    const taken = new Set(enabled.flatMap((e) => e.default_card_types ?? []));
    const entries = [
      ...enabled.map((e) => ({ workflowKey: e.workflow_key, defaultCardTypes: e.default_card_types ?? [] })),
      ...missing.map((w) => ({
        workflowKey: w.key,
        defaultCardTypes: taken.has(w.type) ? [] : [w.type],
      })),
    ];
    await ctx.store.append(
      [
        {
          streamId: streamId.project(p.id),
          event: { type: 'ProjectWorkflowsSet', payload: { projectId: p.id, enabled: entries, by: p.created_by } },
          actor: SYSTEM_ACTOR,
          scope: projectScope(orgId, p.id),
        },
      ],
      { tx },
    );
  }
}

/** Boot: every business organization gets its workflows (catches organizations switched before they shipped). */
export async function ensureBusinessWorkflowsAtBoot(ctx: Ctx): Promise<number> {
  const orgs = await rows<{ id: string }>(ctx.pool, `SELECT id FROM organizations WHERE mode='business'`, []);
  let n = 0;
  for (const o of orgs) {
    await withAppendTx(ctx.pool, async (tx) => {
      await ensureBusinessWorkflows(ctx, tx, o.id);
    });
    n++;
  }
  return n;
}
