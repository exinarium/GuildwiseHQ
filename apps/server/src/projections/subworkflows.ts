import type { EventOf, EventType } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';
import { mutateCard } from './util.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

/**
 * Sub-workflow runs (docs/design/workflow-builder.md section 4): one row per child a `subworkflow` stage started.
 * `SubworkflowRefused` has no projection of its own: the desk alert and the card message that go with it carry it.
 */
export const subworkflowProjectors: Record<string, Projector> = {
  SubworkflowStarted: async (tx, e) => {
    const p = ev<'SubworkflowStarted'>(e).payload;
    // The event sequence of the move that brought the parent into the stage: the dedupe key of the run. Taken from the
    // projected transitions, which are a function of the log, so a rebuild gives the same key.
    const entry = await one<{ event_seq: string }>(
      tx,
      `SELECT event_seq FROM card_transitions
        WHERE card_id=$1 AND to_stage=$2 AND from_stage IS DISTINCT FROM to_stage ORDER BY id DESC LIMIT 1`,
      [p.cardId, p.stageId],
    );
    await exec(
      tx,
      `INSERT INTO subworkflow_runs (parent_card_id, stage_id, entry_seq, rework_round, child_card_id, child_project_id,
         workflow_key, workflow_version, mode, status, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        p.cardId,
        p.stageId,
        entry?.event_seq ?? e.seq.toString(),
        p.reworkRound,
        p.childCardId,
        p.childProjectId,
        p.workflowKey,
        p.workflowVersion,
        p.mode,
        p.mode === 'wait' ? 'open' : 'continued',
        e.createdAt,
      ],
    );
    if (p.mode === 'wait')
      await mutateCard(tx, e, p.cardId, () =>
        exec(
          tx,
          `UPDATE cards SET status='waiting', updated_at=$2
            WHERE id=$1 AND status NOT IN ('done','cancelled')`,
          [p.cardId, e.createdAt],
        ),
      );
  },

  // A card moved back into a stage whose child still runs waits on that child again: no new run, only the status.
  SubworkflowAttached: async (tx, e) => {
    const p = ev<'SubworkflowAttached'>(e).payload;
    await mutateCard(tx, e, p.cardId, () =>
      exec(
        tx,
        `UPDATE cards SET status='waiting', updated_at=$2 WHERE id=$1 AND status NOT IN ('done','cancelled')`,
        [p.cardId, e.createdAt],
      ),
    );
  },

  SubworkflowResolved: async (tx, e) => {
    const p = ev<'SubworkflowResolved'>(e).payload;
    await exec(
      tx,
      `UPDATE subworkflow_runs SET status=$3, resolved_at=$4, fields=$5
        WHERE parent_card_id=$1 AND child_card_id=$2`,
      [p.cardId, p.childCardId, p.result, e.createdAt, JSON.stringify(p.fields)],
    );
    if (Object.keys(p.fields).length > 0)
      await exec(tx, `UPDATE cards SET fields = fields || $2::jsonb, updated_at=$3 WHERE id=$1`, [
        p.cardId,
        JSON.stringify(p.fields),
        e.createdAt,
      ]);
  },
};
