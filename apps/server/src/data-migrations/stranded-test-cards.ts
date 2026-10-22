import { streamId } from '@aom/shared';
import { cardMessage, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { integrationTestsOf, testDeploySkipReason } from '../commands/integration-tests.ts';
import { one, type Row, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `stranded-test-cards-2026-10`: a card a manager (or the CEO) moved straight into Test skipped the server-run Test
 * deploy stage, the only place that records `test_deploy_state = 'skipped'`, so the dispatcher never offered it to a
 * tester. The move now records it; this releases the cards stranded before the fix: queued, unclaimed, in a stage that
 * waits for the Test deploy result (`env_strict`), `test_deploy_state` NULL, and a project/card for which Test deploy
 * would have skipped (integration tests off, a remote target, ...). Each gets the `TestDeployResolved` (skipped) event
 * the stage would have appended, by the system actor. A card that needs an environment is left alone: the server
 * already starts one for it. Idempotent: a released card no longer matches, and the run is recorded once in
 * `data_migrations`. A projection rebuild reproduces the result.
 */
export const STRANDED_TEST_CARDS_MIGRATION = 'stranded-test-cards-2026-10';

export interface StrandedTestCardsReport {
  released: Array<{ ref: string; reason: string }>;
}

export async function migrateStrandedTestCards(
  env: DataMigrationEnv,
): Promise<StrandedTestCardsReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [STRANDED_TEST_CARDS_MIGRATION]))
    return null;
  const stranded = await selectRows<Row>(
    pool,
    `SELECT c.* FROM cards c
       JOIN workflow_stages st ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = c.stage
      WHERE COALESCE(st.env_strict, false) AND c.status = 'queued' AND c.claim_id IS NULL
        AND c.test_deploy_state IS NULL
      ORDER BY c.created_at`,
  );
  const report: StrandedTestCardsReport = { released: [] };
  for (const card of stranded) {
    const project = (await one(pool, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Row;
    const reason = testDeploySkipReason(card, project, integrationTestsOf(project));
    if (!reason) continue;
    await store.append([
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'TestDeployResolved',
          payload: {
            cardId: card.id,
            result: 'skipped',
            reason,
            ...(card.head_sha ? { sha: card.head_sha } : {}),
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(card.org_id, card.project_id),
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `${card.ref} was moved to Test without passing Test deploy, so no tester was offered it. Test deploy skipped: ${reason}. It is released to the tester now.`,
      ),
    ]);
    report.released.push({ ref: card.ref, reason });
    log(`${STRANDED_TEST_CARDS_MIGRATION}: released ${card.ref}`);
  }
  await pool.query(
    `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
     ON CONFLICT (name) DO NOTHING`,
    [STRANDED_TEST_CARDS_MIGRATION, clock.now(), JSON.stringify(report)],
  );
  log(`${STRANDED_TEST_CARDS_MIGRATION}: ${report.released.length} card(s) released`);
  return report;
}
