import { BUSINESS_CARD_TYPES, BUSINESS_WORKFLOW_KEY, streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';

/**
 * Enables the shipped business workflows on the organization's projects (the primary stays the primary; every enabled
 * entry is kept). The workflows themselves are true built-ins, registered at boot with the other built-ins
 * (`registerBuiltins`), so there is nothing to install per organization. Idempotent. A workflow the project once had and
 * an owner turned off is never enabled again; only workflows the project has never had are added.
 */
export async function ensureBusinessWorkflows(ctx: Ctx, tx: Tx, orgId: string): Promise<void> {
  const installed = new Set(
    (
      await rows<{ key: string }>(
        tx,
        `SELECT DISTINCT key FROM workflow_versions
          WHERE (org_id IS NULL OR org_id=$1) AND status='active' AND project_id IS NULL`,
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
    // A workflow an owner turned off stays off: only the workflows this project has never had are added. "Had" is read
    // from the event history (every `ProjectWorkflowsSet` that listed it), so no migration or flag is needed.
    const had = new Set(
      (
        await rows<{ key: string }>(
          tx,
          `SELECT DISTINCT x->>'workflowKey' AS key
             FROM events e, jsonb_array_elements(e.payload->'enabled') x
            WHERE e.stream_id=$1 AND e.type='ProjectWorkflowsSet'`,
          [streamId.project(p.id)],
        )
      ).map((r) => r.key),
    );
    const have = new Set([...enabled.map((e) => e.workflow_key), ...had]);
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
          event: {
            type: 'ProjectWorkflowsSet',
            payload: { projectId: p.id, enabled: entries, by: p.created_by },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(orgId, p.id),
        },
      ],
      { tx },
    );
  }
}

/**
 * Boot: EVERY organization's projects get the shipped business workflows enabled, whatever its default view. A workflow
 * added in a later release is registered as a built-in first, then reaches every existing project at the next start.
 */
export async function ensureBusinessWorkflowsAtBoot(ctx: Ctx): Promise<number> {
  const orgs = await rows<{ id: string }>(ctx.pool, `SELECT id FROM organizations ORDER BY id`, []);
  let n = 0;
  for (const o of orgs) {
    try {
      await withAppendTx(ctx.pool, async (tx) => {
        await ensureBusinessWorkflows(ctx, tx, o.id);
      });
      n++;
    } catch (err) {
      ctx.log.warn({ orgId: o.id, err }, 'business workflows could not be enabled for this organization');
    }
  }
  return n;
}
