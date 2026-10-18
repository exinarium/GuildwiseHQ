import { isOrgManager, streamId } from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { forbidden } from '../errors.ts';
import { projectScope, userActor } from './common.ts';

/**
 * Manual project pause / resume (dispatcher/project-hold.ts is the rule everything else asks). Only an organization Owner
 * or Admin of the project's organization may do either, and only through a signed-in session: the agent API, the runner
 * and the CEO's action registry have no route to these, so an agent can neither bench nor free a project. Both are
 * idempotent: pausing a paused project (or resuming a running one) changes nothing and appends nothing. The events are
 * the audit trail (who, when, why).
 */
async function assertManager(
  tx: Parameters<typeof orgRoleOf>[0],
  user: AuthSession['user'],
  orgId: string,
  what: string,
): Promise<void> {
  if (!isOrgManager({ orgRole: await orgRoleOf(tx, user.id, orgId) }))
    throw forbidden(`only an organization Owner or Admin can ${what} a project`);
}

/** Returns true when the project was paused by this call, false when it already was. */
export async function pauseProject(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  reason?: string,
): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    await assertManager(tx, user, p.org_id, 'pause');
    const cur = await one(tx, 'SELECT paused_at FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    if (cur?.paused_at) return false;
    const text = reason?.trim();
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectPaused',
            payload: { projectId, by: user.id, ...(text ? { reason: text } : {}) },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    return true;
  });
}

/** Returns true when the project was resumed by this call; the dispatcher is triggered so queued work goes on. */
export async function resumeProject(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<boolean> {
  const resumed = await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    await assertManager(tx, user, p.org_id, 'resume');
    const cur = await one(tx, 'SELECT paused_at FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    if (!cur?.paused_at) return false;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectResumed', payload: { projectId, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    return true;
  });
  if (resumed) ctx.services.dispatcher.trigger();
  return resumed;
}
