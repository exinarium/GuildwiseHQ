import { randomUUID } from 'node:crypto';
import { type DeskResolution, streamId } from '@aom/shared';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from './commands/common.ts';
import type { Ctx } from './context.ts';
import { one } from './db/sql.ts';
import type { Tx } from './db/tx.ts';

/**
 * M3 -> M2 seam. DevOps approvals (`kind 'approval'`, `subkind 'devops'`) and vault sync conflicts
 * (`kind 'escalation'`, `subkind 'vault_conflict'`) are desk items owned by the user whose workstation or vault they
 * concern (docs/ARCHITECTURE.md section 17.2): they are created in that user's own organization with no project or
 * card, so the project's other members neither see nor answer them. They are pinned (hard stops).
 *
 * The desk resolve path (`commands/desk.ts`) calls `resolveDevOpsApproval` / `resolveVaultConflict` for these kinds;
 * the M3 endpoints call `closeDeskItemIn` so the item never stays open after being resolved elsewhere.
 */
export interface DeskItemRequest {
  kind: 'approval' | 'escalation';
  subkind: 'devops' | 'vault_conflict';
  title: string;
  body: string;
  pinned: boolean;
  blocking: boolean;
  /** Organization (user) that owns and sees the item. */
  orgId: string;
  /** Kept for callers' context; desk items of this kind are never project- or card-scoped. */
  projectId?: string | null;
  cardId?: string | null;
  /** The user who must answer (the workstation or vault owner). */
  routeToUserId: string;
  /** Domain ids the resolve endpoint needs (requestId, vaultId, workstationId, ...). */
  context: Record<string, unknown>;
}

/** Appends `DeskItemCreated` in `tx` (an append transaction) and returns the new item id. */
export async function raiseDeskItem(ctx: Ctx, tx: Tx, req: DeskItemRequest): Promise<{ deskItemId: string }> {
  const deskItemId = randomUUID();
  const org = req.routeToUserId;
  await ctx.store.append(
    [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: req.kind,
            subkind: req.subkind,
            title: req.title,
            body: req.body,
            options: [],
            blocking: req.blocking,
            pinned: req.pinned,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(org),
      },
    ],
    { tx },
  );
  return { deskItemId };
}

/** Resolves the desk item in `tx` if it is still open (used when the M3 pages resolve the underlying request). */
export async function closeDeskItemIn(
  ctx: Ctx,
  tx: Tx,
  deskItemId: string | null | undefined,
  by: { userId: string },
  resolution: DeskResolution,
  note?: string,
): Promise<void> {
  if (!deskItemId) return;
  const item = await one(
    tx,
    `SELECT org_id, project_id FROM desk_items WHERE id=$1 AND status='open' FOR UPDATE`,
    [deskItemId],
  );
  if (!item) return;
  await ctx.store.append(
    [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemResolved',
          payload: {
            deskItemId,
            resolution,
            ...(note ? { note } : {}),
            by: { kind: 'user', userId: by.userId },
          },
        },
        actor: userActor(by.userId),
        scope: item.project_id ? projectScope(item.org_id, item.project_id) : orgScope(item.org_id),
      },
    ],
    { tx },
  );
}
