import { PACK_AUTHORING_CAPABILITY } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { applyHolders } from './pack-holders.ts';
import { HOLDS_PACK_SQL, isTrustedRow, packWorkstations } from './pack-support.ts';

/** How long after a "no" the same pack is not asked for again on the same workstation. */
const ASK_AGAIN_DAYS = 30;

/**
 * Project packs follow sessions (R3c; docs/ARCHITECTURE.md section 38.8). A pack that was added to a project applies in that
 * project's sessions, but only where its files are: the workstations the admin chose. When someone creates a Discovery or
 * Boardroom session in the project on a workstation that does not hold one of the project's approved packs, that workstation is
 * added to the pack's holders, under the R3a rules: the person is asked first (a desk item addressed to them; nothing is cloned and
 * no file is sent until they accept) unless the pack is theirs to begin with (they added it). A pack that needs a deploy key or
 * token (sealed in an admin's browser for named workstations) is skipped: an admin has to place it. A "no" is remembered for 30
 * days so the same question does not come with every session. Returns the ids of the packs that were added or asked for.
 */
export async function followProjectPacks(
  ctx: Ctx,
  a: { orgId: string; projectId: string; workstationId: string; userId: string },
): Promise<string[]> {
  const known = (await packWorkstations(ctx.pool, a.orgId)).find((w) => w.id === a.workstationId);
  if (!known) return []; // not a workstation of an active member that holds packs
  const packs = await rows(
    ctx.pool,
    `SELECT p.id FROM packs p
      WHERE p.org_id=$1 AND p.scope='project' AND p.project_id=$2 AND p.visibility='org' AND p.removed_at IS NULL
        AND p.credential_kind IS NULL AND p.pinned_sha IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM workstations w WHERE w.id=$3 AND ${HOLDS_PACK_SQL})
        AND NOT EXISTS (SELECT 1 FROM pack_assignments pa WHERE pa.pack_id=p.id AND pa.workstation_id=$3 AND pa.status='pending')
        AND NOT EXISTS (SELECT 1 FROM desk_items d WHERE d.subject_key = 'pack_assignment:' || p.id || ':' || $3
                          AND d.created_at > $4)
      ORDER BY p.added_at`,
    [
      a.orgId,
      a.projectId,
      a.workstationId,
      new Date(ctx.clock.now().getTime() - ASK_AGAIN_DAYS * 86_400_000),
    ],
  );
  if (!packs.length) return [];
  const project = await one(ctx.pool, 'SELECT key, name FROM projects WHERE id=$1', [a.projectId]);
  const creator = await one(ctx.pool, 'SELECT display_name FROM users WHERE id=$1', [a.userId]);
  const why =
    `${creator?.display_name ?? 'You'} started a session in the project ${project?.key ?? ''} ${project?.name ?? ''}`
      .replace(/\s+/g, ' ')
      .trim() + ',';
  const done: string[] = [];
  const toSync: string[] = [];
  const toRelay: string[] = [];
  for (const p of packs) {
    await withAppendTx(ctx.pool, async (tx) => {
      const pack = await one(tx, 'SELECT * FROM packs WHERE id=$1 AND removed_at IS NULL FOR UPDATE', [p.id]);
      if (!pack || !isTrustedRow(pack)) return; // only what an Owner or Admin approved travels by itself
      const authored = pack.source === 'authored';
      if (
        authored &&
        !(await one(
          tx,
          'SELECT 1 FROM workstation_capabilities WHERE workstation_id=$1 AND $2 = ANY(capabilities)',
          [a.workstationId, PACK_AUTHORING_CAPABILITY],
        ))
      )
        return;
      const current = ((pack.workstation_ids as string[] | null) ?? []) as string[];
      // no choice recorded means "the adding admin's own workstations": naming a holder must not drop them
      const base = current.length
        ? current
        : (await packWorkstations(tx, a.orgId)).filter((w) => w.user_id === pack.added_by).map((w) => w.id);
      if (base.includes(a.workstationId)) return;
      const change = await applyHolders(
        ctx,
        tx,
        pack,
        { userId: a.userId, name: creator?.display_name ?? undefined, why, askActor: true },
        [...base, a.workstationId],
      );
      done.push(pack.id);
      toSync.push(...change.sync);
      if (authored) toRelay.push(pack.id);
    });
  }
  if (done.length) {
    const { syncWorkstations } = await import('./packs.ts');
    await syncWorkstations(ctx, [...new Set(toSync)]);
    const { relayAuthoredBundles } = await import('./pack-authoring.ts');
    for (const id of toRelay) await relayAuthoredBundles(ctx, id);
  }
  return done;
}
