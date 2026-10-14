import { streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `push-branch-retired-2026-10` (backlog #61: no card or agent branch is pushed unless the goal is a pull request).
 * The `push_branch` completion action is retired. A project can never hold it (its default is `merge` or `pr`, enforced
 * by a CHECK), so only cards carry it: every open card (not done, not cancelled) with a card-level `push_branch` gets
 * its override cleared, as one `CardUpdated` per card by the system actor, and then follows the project default
 * (`merge` unless the project chose `pr`). Done and cancelled cards keep the value recorded for them, and cards already
 * finalized with `push_branch` (waiting for their branch to be merged) are left as they are: their branch was pushed
 * before the rule, and the merge check still reads the old value. Old events keep parsing. A projection rebuild
 * reproduces the result. Recorded once in `data_migrations`, under an advisory lock; a second boot does nothing.
 */
export const PUSH_BRANCH_RETIRED_MIGRATION = 'push-branch-retired-2026-10';
const LOCK_ID = 7338;
export const PUSH_BRANCH_RETIRED_REASON =
  'the push_branch completion action was retired: a card branch is only pushed for a pull request; the card now follows the project default';

export interface PushBranchRetiredReport {
  cleared: Array<{ ref: string }>;
}

export async function migratePushBranchRetired(
  env: DataMigrationEnv,
): Promise<PushBranchRetiredReport | null> {
  const { pool, store, clock, log } = env;
  const done = () =>
    one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [PUSH_BRANCH_RETIRED_MIGRATION]);
  if (await done()) return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await done()) return null;
    const open = await selectRows<{ id: string; ref: string; org_id: string; project_id: string }>(
      pool,
      `SELECT c.id, c.ref, p.org_id, c.project_id
         FROM cards c JOIN projects p ON p.id = c.project_id
        WHERE c.completion_action = 'push_branch' AND c.status NOT IN ('done','cancelled')
        ORDER BY c.created_at`,
    );
    const report: PushBranchRetiredReport = { cleared: [] };
    for (const c of open) {
      await store.append([
        {
          streamId: streamId.card(c.id),
          event: {
            type: 'CardUpdated',
            payload: {
              cardId: c.id,
              changes: { completionAction: null },
              reason: PUSH_BRANCH_RETIRED_REASON,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(c.org_id, c.project_id),
        },
      ]);
      report.cleared.push({ ref: c.ref });
      log(`${PUSH_BRANCH_RETIRED_MIGRATION}: ${c.ref} was push_branch, now follows the project`);
    }
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO NOTHING`,
      [PUSH_BRANCH_RETIRED_MIGRATION, clock.now(), JSON.stringify(report)],
    );
    log(`${PUSH_BRANCH_RETIRED_MIGRATION}: ${report.cleared.length} open card(s) now follow their project`);
    return report;
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      lock.release();
    }
  }
}
