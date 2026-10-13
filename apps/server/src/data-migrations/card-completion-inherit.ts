import { streamId } from '@aom/shared';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `card-completion-inherit-2026-10`: cards used to get a copy of the project's default completion action when they
 * were created (or one chosen by the intake agent), so a later change to the project never reached them. A card now
 * follows its project unless someone deliberately overrides it. This clears the card-level value on every open card
 * (not done, not cancelled) that has one, as one `CardUpdated` per card by the system actor; done and cancelled cards
 * keep the value recorded for them. A projection rebuild reproduces the result. Recorded once in `data_migrations`,
 * under an advisory lock; a second boot does nothing.
 */
export const CARD_COMPLETION_INHERIT_MIGRATION = 'card-completion-inherit-2026-10';
const LOCK_ID = 7337;
export const CARD_COMPLETION_INHERIT_REASON = 'follow the project default';

export interface CardCompletionInheritReport {
  cleared: Array<{ ref: string; was: string }>;
}

export async function migrateCardCompletionInherit(
  env: DataMigrationEnv,
): Promise<CardCompletionInheritReport | null> {
  const { pool, store, clock, log } = env;
  const done = () =>
    one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [CARD_COMPLETION_INHERIT_MIGRATION]);
  if (await done()) return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await done()) return null;
    const open = await selectRows<{
      id: string;
      ref: string;
      org_id: string;
      project_id: string;
      completion_action: string;
    }>(
      pool,
      `SELECT c.id, c.ref, p.org_id, c.project_id, c.completion_action
         FROM cards c JOIN projects p ON p.id = c.project_id
        WHERE c.completion_action IS NOT NULL AND c.status NOT IN ('done','cancelled')
        ORDER BY c.created_at`,
    );
    const report: CardCompletionInheritReport = { cleared: [] };
    for (const c of open) {
      await store.append([
        {
          streamId: streamId.card(c.id),
          event: {
            type: 'CardUpdated',
            payload: {
              cardId: c.id,
              changes: { completionAction: null },
              reason: CARD_COMPLETION_INHERIT_REASON,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(c.org_id, c.project_id),
        },
      ]);
      report.cleared.push({ ref: c.ref, was: c.completion_action });
      log(
        `${CARD_COMPLETION_INHERIT_MIGRATION}: ${c.ref} was ${c.completion_action}, now follows the project`,
      );
    }
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO NOTHING`,
      [CARD_COMPLETION_INHERIT_MIGRATION, clock.now(), JSON.stringify(report)],
    );
    log(
      `${CARD_COMPLETION_INHERIT_MIGRATION}: ${report.cleared.length} open card(s) now follow their project`,
    );
    return report;
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      lock.release();
    }
  }
}
