import { streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { releasesPaused } from '../delivery/mode.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `guided-mode-2026-10`: approving a guided setup now switches the project to recipe mode by itself. Projects whose guided
 * setup was approved before that stay on `instructions` (real releases refused, after-merge triggers silent), so each of them
 * is switched once. A project without an approved guided setup is never touched. Only events are appended (a rebuild
 * reproduces the result); a project already in recipe mode gets nothing, so running it twice changes nothing.
 */
export const GUIDED_MODE_MIGRATION = 'guided-mode-2026-10';
export const GUIDED_MODE_REASON = 'guided setup approved before mode switching was automatic';

export async function migrateGuidedMode(env: DataMigrationEnv): Promise<string[] | null> {
  const { pool, store, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [GUIDED_MODE_MIGRATION])) return null;
  const switched: string[] = [];
  const candidates = await rows(
    pool,
    `SELECT p.id, p.org_id, p.key FROM projects p
       JOIN delivery_recipes r ON r.project_id = p.id
      WHERE p.kind='project' AND p.delivery_mode='instructions'
        AND r.setup IS NOT NULL AND r.approved_hash IS NOT NULL`,
  );
  for (const p of candidates) {
    let did = false;
    await withAppendTx(pool, async (tx) => {
      // read again inside the transaction: a project switched since the list was made is left alone
      const still = await one(
        tx,
        `SELECT 1 AS x FROM projects WHERE id=$1 AND delivery_mode='instructions'`,
        [p.id],
      );
      if (!still || (await releasesPaused(tx, p.id))) return;
      did = true;
      await store.append(
        [
          {
            streamId: streamId.project(p.id),
            event: {
              type: 'DeliveryModeSet',
              payload: {
                projectId: p.id,
                orgId: p.org_id,
                mode: 'recipe',
                by: null,
                reason: GUIDED_MODE_REASON,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: projectScope(p.org_id, p.id),
          },
        ],
        { tx },
      );
    });
    if (!did) continue;
    switched.push(p.key);
    log(`${p.key}: delivery switched to recipe (${GUIDED_MODE_REASON})`);
  }
  await exec(
    pool,
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
    [GUIDED_MODE_MIGRATION, env.clock.now(), JSON.stringify({ switched })],
  );
  return switched;
}
