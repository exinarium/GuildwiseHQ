import { randomUUID } from 'node:crypto';
import {
  DESK_SUBKIND,
  REGRESSION_LOOP_MAX_RERUNS,
  type RegressionLoopStopReason,
  streamId,
} from '@aom/shared';
import { one, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR } from './common.ts';

/**
 * The regression loop (docs: DESIGN P4 of regression-stops-on-fixed-bug): a failed regression run on a project with the
 * switch on waits until its bugs are merged, DevOps redeploys the app under test, and the run starts again, at most
 * `REGRESSION_LOOP_MAX_RERUNS` times. These are the event builders shared by the suite outcome and the dispatcher pass.
 */

/** Runs in a chain at most: the run a person started plus the automatic reruns. */
export const REGRESSION_LOOP_MAX_RUNS = 1 + REGRESSION_LOOP_MAX_RERUNS;

const MIN_SHA = /^[0-9a-f]{7,40}$/i;
/** A commit sha, or null when the value is not one (only checked values go into the DevOps request). */
export const safeSha = (v: unknown): string | null => (typeof v === 'string' && MIN_SHA.test(v) ? v : null);
/** A branch name with plain characters only, or null. */
export const safeBranch = (v: unknown): string | null =>
  typeof v === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(v) && !v.includes('..') ? v : null;

/** A non-blocking regression-loop desk alert on the run card. */
export function loopAlert(run: Row, title: string, body: string): AppendInput {
  const deskItemId = randomUUID();
  return {
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'DeskItemCreated',
      payload: {
        deskItemId,
        kind: 'alert',
        subkind: DESK_SUBKIND.regressionLoop,
        title,
        body,
        options: [],
        blocking: false,
        pinned: false,
        cardId: run.id,
        projectId: run.project_id,
        affectedCardIds: [run.id],
        askedBy: { kind: 'system' },
      },
    },
    actor: SYSTEM_ACTOR,
    scope: projectScope(run.org_id, run.project_id),
  };
}

/** The loop of `run` ends: the event, a message on the run and (unless `quiet`) a desk alert with the same text. */
export function loopStoppedEvents(
  run: Row,
  reason: RegressionLoopStopReason,
  text: string,
  opts: { detail?: string; requestId?: string; supersededBy?: string; quiet?: boolean } = {},
): AppendInput[] {
  const events: AppendInput[] = [
    {
      streamId: streamId.card(run.id),
      event: {
        type: 'RegressionLoopStopped',
        payload: {
          runCardId: run.id,
          projectId: run.project_id,
          reason,
          detail: (opts.detail ?? '').slice(0, 1000),
          ...(opts.requestId ? { requestId: opts.requestId } : {}),
          ...(opts.supersededBy ? { supersededBy: opts.supersededBy } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(run.org_id, run.project_id),
    },
    cardMessage(run, { kind: 'system' }, 'system', text),
  ];
  if (!opts.quiet)
    events.push(
      loopAlert(
        run,
        `Regression loop stopped: ${run.ref}`,
        `${text}${opts.detail ? `\n\n${opts.detail.slice(0, 1000)}` : ''}`,
      ),
    );
  return events;
}

/** The loop row whose rerun `cardId` is, if any. */
export async function parentLoop(
  tx: Tx,
  cardId: string,
): Promise<{ iteration: number; root_card_id: string } | undefined> {
  return one(tx, 'SELECT iteration, root_card_id FROM regression_loops WHERE next_run_card_id=$1', [cardId]);
}

/**
 * The loop part of a failed regression run on a project with the loop on: the `FullSuiteFailed.loop` payload, older
 * waiting runs of the same platform superseded, and the cap.
 */
export async function failedRunLoop(
  tx: Tx,
  run: Row,
  workstationId: string,
  platform: string | undefined,
): Promise<{
  loop: { iteration: number; rootCardId: string; workstationId: string };
  events: AppendInput[];
}> {
  const parent = await parentLoop(tx, run.id);
  const loop = {
    iteration: parent ? parent.iteration + 1 : 1,
    rootCardId: parent?.root_card_id ?? run.id,
    workstationId,
  };
  const events: AppendInput[] = [];
  const older = await rows(
    tx,
    `SELECT l.run_card_id AS id, c.ref, c.org_id, c.project_id FROM regression_loops l JOIN cards c ON c.id = l.run_card_id
      WHERE l.project_id=$1 AND l.state='waiting_fixes' AND l.platform IS NOT DISTINCT FROM $2 AND l.run_card_id <> $3`,
    [run.project_id, platform ?? null, run.id],
  );
  for (const o of older)
    events.push(
      ...loopStoppedEvents(
        o,
        'superseded',
        `The newer regression run ${run.ref} failed too; the loop follows it now.`,
        {
          supersededBy: run.id,
          quiet: true,
        },
      ),
    );
  if (loop.iteration >= REGRESSION_LOOP_MAX_RUNS)
    events.push(
      ...loopStoppedEvents(
        run,
        'cap',
        `The regression loop stopped after ${loop.iteration} runs without a green run. Fix the remaining bugs and start the regression by hand.`,
      ),
    );
  else
    events.push(
      cardMessage(
        run,
        { kind: 'system' },
        'system',
        `Regression loop (run ${loop.iteration} of ${REGRESSION_LOOP_MAX_RUNS}): when the bugs of this run are merged (or the app is redeployed after a stale target), DevOps redeploys the app and the run starts again.`,
      ),
    );
  return { loop, events };
}

/** A rerun of the loop went green: an alert and a message on the run a person started. */
export async function greenRunEvents(tx: Tx, run: Row): Promise<AppendInput[]> {
  const parent = await parentLoop(tx, run.id);
  if (!parent) return [];
  const n = parent.iteration + 1;
  const root = await one(tx, 'SELECT id, ref, org_id, project_id FROM cards WHERE id=$1', [
    parent.root_card_id,
  ]);
  const text = `${run.ref} is green after ${n} runs: the regression loop is done.`;
  return [
    loopAlert(run, `Regression green: ${run.ref}`, text),
    ...(root && root.id !== run.id ? [cardMessage(root, { kind: 'system' }, 'system', text)] : []),
  ];
}
