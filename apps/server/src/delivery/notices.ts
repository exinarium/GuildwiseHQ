import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';

/**
 * Desk notices of the delivery flow (alerts: the action itself is a button on the Delivery page, never a relayed answer):
 * "a recipe waits for your approval" and "a release is ready". One open notice per subject; it closes when the subject does.
 */
export async function raiseDeskNotice(
  ctx: Ctx,
  n: {
    orgId: string;
    projectId: string;
    subkind: string;
    subjectKey: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
    pinned?: boolean;
  },
): Promise<void> {
  const open = await one(
    ctx.pool,
    `SELECT id FROM desk_items WHERE org_id=$1 AND subject_key=$2 AND status='open'`,
    [n.orgId, n.subjectKey],
  ).catch(() => undefined);
  if (open) return;
  const deskItemId = randomUUID();
  await ctx.store.append([
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: n.subkind,
          title: n.title.slice(0, 280),
          body: n.body,
          options: [],
          blocking: false,
          pinned: n.pinned ?? false,
          projectId: n.projectId,
          affectedCardIds: [],
          askedBy: { kind: 'system' },
          subjectKey: n.subjectKey,
          ...(n.data ? { data: n.data } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(n.orgId, n.projectId),
    },
  ]);
}

/** Closes the open notice of a subject (the thing it asked for happened). */
export async function closeDeskNotice(ctx: Ctx, subjectKey: string, byUserId?: string): Promise<void> {
  const open = await one(
    ctx.pool,
    `SELECT id, org_id, project_id FROM desk_items WHERE subject_key=$1 AND status='open'`,
    [subjectKey],
  ).catch(() => undefined);
  if (!open) return;
  await ctx.store.append([
    {
      streamId: streamId.desk(open.id),
      event: {
        type: 'DeskItemResolved',
        payload: {
          deskItemId: open.id,
          resolution: 'acknowledged',
          by: byUserId ? { kind: 'user', userId: byUserId } : { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: open.project_id
        ? projectScope(open.org_id, open.project_id)
        : ({ orgId: open.org_id, projectId: null, audience: 'org' } as const),
    },
  ]);
}
