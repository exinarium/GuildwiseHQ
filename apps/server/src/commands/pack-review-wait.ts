import { randomUUID } from 'node:crypto';
import { isOrgManager, streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { forbidden } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { orgScope, SYSTEM_ACTOR } from './common.ts';
import { authorWorkstationOf } from './pack-support.ts';

/**
 * Owner decision Q67: the server keeps NO copy of an authored organization pack's text, so a reviewer cannot read it while the
 * author's workstation is offline. The review waits for that workstation, and the reviewer is told on their desk when it comes
 * online. The wait is operational state (`pack_review_waits`: who, which pack, which workstation; no text). Nothing here reads, stores
 * or relays pack content: the read itself is `startReviewRead` (the runner seals the files to the reviewer's page).
 */
export const PACK_REVIEW_READY_SUBKIND = 'pack_review_ready';

/** A wait older than this is forgotten (the reviewer has long moved on). */
const WAIT_KEEP_MS = 14 * 86_400_000;

export interface ReviewWaitDto {
  waiting: boolean;
  /** The author's workstation, when waiting. */
  workstationName?: string;
  since?: string;
}

async function packOfReview(ctx: Ctx, orgId: string, packId: string) {
  return one(
    ctx.pool,
    `SELECT * FROM packs WHERE id=$1 AND org_id=$2 AND removed_at IS NULL AND visibility='org' AND source='authored'`,
    [packId, orgId],
  );
}

/**
 * After `startReviewRead` accepted a reviewer's request: when the author's workstation is not connected, remember the wait so the
 * reviewer is told when it is. Returns what the page shows ("waiting for <workstation>"). Idempotent per reviewer and pack.
 */
export async function noteReviewWait(
  ctx: Ctx,
  who: { userId: string; orgId: string; role: string },
  packId: string,
): Promise<ReviewWaitDto> {
  if (!isOrgManager({ orgRole: who.role as never }))
    throw forbidden('only owners and admins review capability packs');
  const p = await packOfReview(ctx, who.orgId, packId);
  const wsId = p ? authorWorkstationOf(p) : null;
  if (!p || !wsId) return { waiting: false };
  const ws = await one(ctx.pool, 'SELECT name, connected FROM workstations WHERE id=$1', [wsId]);
  if (!ws || ws.connected === true) {
    await exec(ctx.pool, 'DELETE FROM pack_review_waits WHERE pack_id=$1 AND reviewer_user_id=$2', [
      packId,
      who.userId,
    ]);
    return { waiting: false };
  }
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `INSERT INTO pack_review_waits (pack_id, reviewer_user_id, org_id, workstation_id, requested_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (pack_id, reviewer_user_id) DO UPDATE SET workstation_id=EXCLUDED.workstation_id,
       requested_at=EXCLUDED.requested_at, notified_at=NULL`,
    [packId, who.userId, who.orgId, wsId, now],
  );
  return { waiting: true, workstationName: ws.name, since: now.toISOString() };
}

/** Whether this reviewer is waiting for the pack's author workstation (the page asks while it shows "reading"). */
export async function getReviewWait(
  ctx: Ctx,
  who: { userId: string; orgId: string; role: string },
  packId: string,
): Promise<ReviewWaitDto> {
  if (!isOrgManager({ orgRole: who.role as never }))
    throw forbidden('only owners and admins review capability packs');
  const w = await one(
    ctx.pool,
    `SELECT w.requested_at, ws.name, ws.connected FROM pack_review_waits w JOIN workstations ws ON ws.id = w.workstation_id
      WHERE w.pack_id=$1 AND w.reviewer_user_id=$2 AND w.org_id=$3 AND w.notified_at IS NULL`,
    [packId, who.userId, who.orgId],
  );
  if (!w || w.connected === true) return { waiting: false };
  return { waiting: true, workstationName: w.name, since: new Date(w.requested_at).toISOString() };
}

/**
 * A workstation connected: every reviewer who waited for it gets a desk item ("the author's workstation is online: the review of
 * <pack> can be read now"), once. A wait whose pack is gone, private or no longer authored is dropped without a word.
 */
export async function notifyReviewersOfWorkstation(ctx: Ctx, workstationId: string): Promise<number> {
  const now = ctx.clock.now();
  await exec(ctx.pool, 'DELETE FROM pack_review_waits WHERE requested_at < $1', [
    new Date(now.getTime() - WAIT_KEEP_MS),
  ]);
  const waits = await rows(
    ctx.pool,
    `SELECT w.pack_id, w.reviewer_user_id, w.org_id, p.name AS pack_name, ws.name AS ws_name
       FROM pack_review_waits w
       JOIN packs p ON p.id = w.pack_id AND p.removed_at IS NULL AND p.visibility='org' AND p.source='authored'
       JOIN workstations ws ON ws.id = w.workstation_id
      WHERE w.workstation_id=$1 AND w.notified_at IS NULL`,
    [workstationId],
  );
  let told = 0;
  for (const w of waits) {
    // claim it first: two connects in a row tell the reviewer once
    const claimed = await exec(
      ctx.pool,
      `UPDATE pack_review_waits SET notified_at=$3 WHERE pack_id=$1 AND reviewer_user_id=$2 AND notified_at IS NULL`,
      [w.pack_id, w.reviewer_user_id, now],
    );
    if (!claimed) continue;
    const deskItemId = randomUUID();
    const ev: AppendInput = {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'alert',
          subkind: PACK_REVIEW_READY_SUBKIND,
          title: `The author's workstation is online: read "${w.pack_name}" for review`,
          body: `${w.ws_name} is connected again. The text of "${w.pack_name}" lives only on that workstation (the server keeps no copy), so you can read and approve it now. Open Settings > Capabilities and the pack's review.`,
          options: [],
          blocking: false,
          pinned: false,
          affectedCardIds: [],
          addresseeUserId: w.reviewer_user_id,
          askedBy: { kind: 'system' },
          data: { packId: w.pack_id, workstationId },
          subjectKey: `${PACK_REVIEW_READY_SUBKIND}:${w.pack_id}:${w.reviewer_user_id}`,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(w.org_id),
    } as AppendInput;
    await ctx.store.append([ev]);
    told++;
  }
  return told;
}

/** Tells the waiting reviewers as soon as the author's workstation connects. */
export function registerPackReviewWaitHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e) => {
    if (e.event.type !== 'WorkstationConnected') return;
    const id = (e.event.payload as { workstationId?: string }).workstationId;
    if (id)
      await notifyReviewersOfWorkstation(ctx, id).catch((err) =>
        ctx.log.warn({ err }, 'review wait notice failed'),
      );
  });
}
