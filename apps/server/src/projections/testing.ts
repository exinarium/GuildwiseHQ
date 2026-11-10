import type { EventOf, EventType } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';
import { getCard, mutateCard } from './util.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

async function recordRun(
  tx: Tx,
  e: StoredEvent,
  run: {
    cardId: string;
    shiftId?: string | null;
    kind: 'feature' | 'full_suite' | 'regression';
    platform?: string | null;
    result: 'passed' | 'failed';
    evidence: unknown;
  },
): Promise<void> {
  await exec(
    tx,
    `INSERT INTO test_runs (card_id, shift_id, kind, platform, result, evidence, event_seq, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      run.cardId,
      run.shiftId ?? null,
      run.kind,
      run.platform ?? null,
      run.result,
      JSON.stringify(run.evidence),
      e.seq.toString(),
      e.createdAt,
    ],
  );
}

/** A suite or regression card ends (green or with a reported bug): done, nothing else is blocked by it. */
async function finishSuiteCard(tx: Tx, e: StoredEvent, cardId: string): Promise<void> {
  await mutateCard(tx, e, cardId, () =>
    exec(tx, `UPDATE cards SET stage='done', status='done', finalized_at=$2, updated_at=$2 WHERE id=$1`, [
      cardId,
      e.createdAt,
    ]),
  );
}

export const testingProjectors: Record<string, Projector> = {
  TestPassed: async (tx, e) => {
    const p = ev<'TestPassed'>(e).payload;
    const card = await getCard(tx, p.cardId);
    await recordRun(tx, e, {
      cardId: p.cardId,
      shiftId: card?.claim_shift_id,
      kind: 'feature',
      result: 'passed',
      evidence: p.evidence,
    });
    await exec(tx, 'UPDATE cards SET env_parks = 0 WHERE id=$1', [p.cardId]);
  },

  TestFailed: async (tx, e) => {
    const p = ev<'TestFailed'>(e).payload;
    const card = await getCard(tx, p.cardId);
    await recordRun(tx, e, {
      cardId: p.cardId,
      shiftId: card?.claim_shift_id,
      kind: 'feature',
      result: 'failed',
      evidence: p.evidence,
    });
    await exec(tx, 'UPDATE cards SET env_parks = 0 WHERE id=$1', [p.cardId]);
    // The bug child (created by the CardCreated in the same append) goes to the original builder first.
    await exec(tx, 'UPDATE cards SET original_builder_agent_id = $2 WHERE id=$1', [
      p.bugCardId,
      card?.original_builder_agent_id ?? null,
    ]);
  },

  TestReworkRequested: async (tx, e) => {
    const p = ev<'TestReworkRequested'>(e).payload;
    // A rework the CEO or an answer ordered (`instruction`) is not a failed run of the tester. Events written before
    // `instruction` existed never carry it, so a replay records exactly the runs it recorded then.
    if (p.instruction) return;
    const card = await getCard(tx, p.cardId);
    await recordRun(tx, e, {
      cardId: p.cardId,
      shiftId: card?.claim_shift_id,
      kind: 'feature',
      result: 'failed',
      evidence: p.evidence,
    });
  },

  FullSuitePassed: async (tx, e) => {
    const p = ev<'FullSuitePassed'>(e).payload;
    const card = await getCard(tx, p.suiteCardId);
    await recordRun(tx, e, {
      cardId: p.suiteCardId,
      shiftId: card?.claim_shift_id,
      kind: p.kind,
      platform: p.platform ?? card?.fields?.platform,
      result: 'passed',
      evidence: p.evidence,
    });
    await finishSuiteCard(tx, e, p.suiteCardId);
  },

  FullSuiteFailed: async (tx, e) => {
    const p = ev<'FullSuiteFailed'>(e).payload;
    const card = await getCard(tx, p.suiteCardId);
    await recordRun(tx, e, {
      cardId: p.suiteCardId,
      shiftId: card?.claim_shift_id,
      kind: p.kind,
      platform: p.platform ?? card?.fields?.platform,
      result: 'failed',
      evidence: p.evidence,
    });
    await finishSuiteCard(tx, e, p.suiteCardId);
    // P4: the regression loop follows this failed run
    if (p.loop && card)
      await exec(
        tx,
        `INSERT INTO regression_loops (run_card_id, project_id, platform, workstation_id, root_card_id, iteration, mismatch,
                                       state, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'waiting_fixes',$8,$8) ON CONFLICT DO NOTHING`,
        [
          p.suiteCardId,
          card.project_id,
          p.platform ?? card.fields?.platform ?? null,
          p.loop.workstationId ?? null,
          p.loop.rootCardId,
          p.loop.iteration,
          !!p.targetMismatch,
          e.createdAt,
        ],
      );
  },

  RegressionRedeployRequested: async (tx, e) => {
    const p = ev<'RegressionRedeployRequested'>(e).payload;
    await exec(
      tx,
      `UPDATE regression_loops SET state='redeploying', devops_request_id=$2, updated_at=$3 WHERE run_card_id=$1`,
      [p.runCardId, p.requestId, e.createdAt],
    );
  },

  RegressionRequeued: async (tx, e) => {
    const p = ev<'RegressionRequeued'>(e).payload;
    await exec(
      tx,
      `UPDATE regression_loops SET state='requeued', next_run_card_id=$2, deployed_commit=$3, updated_at=$4
        WHERE run_card_id=$1`,
      [p.runCardId, p.nextCardId, p.deployedCommit ?? null, e.createdAt],
    );
  },

  RegressionLoopStopped: async (tx, e) => {
    const p = ev<'RegressionLoopStopped'>(e).payload;
    await exec(
      tx,
      `UPDATE regression_loops SET state='stopped', stop_reason=$2, updated_at=$3 WHERE run_card_id=$1`,
      [p.runCardId, p.reason, e.createdAt],
    );
  },

  // The bug cards a suite or regression run reported, with their dedupe keys (migration 2890 backfills the same way).
  BugReported: async (tx, e) => {
    const p = ev<'BugReported'>(e).payload;
    const runCardId = p.regressionCardId ?? p.suiteCardId;
    if (!runCardId) return;
    await exec(
      tx,
      `INSERT INTO suite_run_bugs (run_card_id, bug_card_id, failure_key, title_key, seen_again, created_at)
       SELECT $1::uuid, $2::uuid, COALESCE($3::text, k.key), k.key, false, $5::timestamptz
         FROM (SELECT left('title:' || lower(btrim(regexp_replace($4::text, '\\s+', ' ', 'g'))), 300) AS key) k
       ON CONFLICT DO NOTHING`,
      [runCardId, p.bugCardId, p.failureKey ?? null, p.title, e.createdAt],
    );
  },

  RegressionBugSeenAgain: async (tx, e) => {
    const p = ev<'RegressionBugSeenAgain'>(e).payload;
    await exec(
      tx,
      `INSERT INTO suite_run_bugs (run_card_id, bug_card_id, failure_key, title_key, seen_again, created_at)
       VALUES ($1,$2,$3,$4,true,$5) ON CONFLICT DO NOTHING`,
      [p.runCardId, p.bugCardId, p.failureKey, p.titleKey, e.createdAt],
    );
  },

  TestEnvironmentParked: async (tx, e) => {
    const p = ev<'TestEnvironmentParked'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(
        tx,
        `UPDATE cards SET status='waiting', parked_request_id=$2, park_problem=$3, env_parks = env_parks + 1,
                updated_at=$4 WHERE id=$1`,
        [p.cardId, p.requestId, p.problem, e.createdAt],
      ),
    );
  },

  BuilderTestsNotRun: async (tx, e) => {
    const p = ev<'BuilderTestsNotRun'>(e).payload;
    await exec(
      tx,
      `INSERT INTO card_test_gaps (card_id, request_id, agent_id, stage, reason, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [p.cardId, p.requestId ?? null, p.agentId, p.stage, p.reason, p.detail, e.createdAt],
    );
  },

  BuilderTestsResultArrived: async (tx, e) => {
    const p = ev<'BuilderTestsResultArrived'>(e).payload;
    await exec(
      tx,
      `UPDATE card_test_gaps SET result_status=$3, result_summary=$4, result_at=$5 WHERE card_id=$1 AND request_id=$2`,
      [p.cardId, p.requestId, p.status, p.summary, e.createdAt],
    );
  },

  TestEnvironmentReady: async (tx, e) => {
    const p = ev<'TestEnvironmentReady'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(
        tx,
        `UPDATE cards SET status='queued', queued_at=$2, parked_request_id=NULL, park_problem=NULL, updated_at=$2
          WHERE id=$1 AND status='waiting'`,
        [p.cardId, e.createdAt],
      ),
    );
  },

  FinalizeApprovalRequested: async (tx, e) => {
    const p = ev<'FinalizeApprovalRequested'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(
        tx,
        `UPDATE cards SET status='waiting', finalize_action=$2, finalize_state='awaiting_approval',
                finalize_desk_item_id=$3, finalize_error=NULL, updated_at=$4 WHERE id=$1`,
        [p.cardId, p.action, p.deskItemId, e.createdAt],
      ),
    );
  },

  // Also handled by the card projector (status waiting); this adds the finalize bookkeeping.
  FinalizeRequested: async (tx, e) => {
    const p = ev<'FinalizeRequested'>(e).payload;
    await exec(
      tx,
      `UPDATE cards SET finalize_action=$2, finalize_state='running', finalize_error=NULL WHERE id=$1`,
      [p.cardId, p.action],
    );
  },

  FinalizeFailed: async (tx, e) => {
    const p = ev<'FinalizeFailed'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(
        tx,
        `UPDATE cards SET status='queued', queued_at=$2, finalize_action=$3, finalize_state='failed',
                finalize_error=$4, updated_at=$2 WHERE id=$1 AND status='waiting'`,
        [p.cardId, e.createdAt, p.action, p.error],
      ),
    );
  },

  // A pre-finalize rebase conflict sends the card to Rework (card projector); the finalize attempt is over.
  RebaseConflict: async (tx, e) => {
    const p = ev<'RebaseConflict'>(e).payload;
    await exec(
      tx,
      `UPDATE cards SET finalize_state=NULL, finalize_error=NULL, finalize_desk_item_id=NULL WHERE id=$1`,
      [p.cardId],
    );
  },

  CardFinalized: async (tx, e) => {
    const p = ev<'CardFinalized'>(e).payload;
    await exec(
      tx,
      `UPDATE cards SET finalize_action=$2, finalize_state=NULL, finalize_error=NULL, finalize_result=$3 WHERE id=$1`,
      [p.cardId, p.action, JSON.stringify(p.resultRef)],
    );
  },
};
