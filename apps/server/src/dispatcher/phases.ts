import { isFollowupTerminal, nextFollowup, phaseCompletion, type Recipe, streamId } from '@aom/shared';
import { SYSTEM_ACTOR } from '../commands/common.ts';
import {
  cardOutcomes,
  followupRows,
  memberRows,
  memberState,
  phaseMessage,
  phaseScope,
  queueBaTask,
} from '../commands/phase-events.ts';
import { followupFinishedEvent, followupVerdict, startFollowup } from '../commands/phase-followups.ts';
import { workingBranchOf } from '../commands/phases.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { requestDeployRun } from '../delivery/runs.ts';
import { releaseChecks } from '../release/publish.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

/** One phase's transaction: a failure is logged and does not starve the phases after it. */
const inTx = (ctx: Ctx, what: string, fn: (tx: Tx) => Promise<void>): Promise<void> =>
  withAppendTx(ctx.pool, fn).catch((err) => ctx.log.error({ err, what }, 'phase pass failed for one phase'));

/** A finalized pr / push_branch card is checked against the working branch this often (per card; AOM_MERGE_CHECK_SECONDS). */
export const MERGE_CHECK_INTERVAL_SECONDS = 180;
const mergeCheckSeconds = (): number =>
  Number(process.env.AOM_MERGE_CHECK_SECONDS) || MERGE_CHECK_INTERVAL_SECONDS;

/**
 * Phase bookkeeping, one pass (docs/design/phases.md A5.4). State based and idempotent: every step locks the phase row,
 * re-checks its status and appends in one transaction, so a second pass (or a restart) does nothing twice. Runs first
 * in each dispatcher pass so the requests, cards and tasks it creates are dispatched in the same pass.
 */
export async function phasePass(ctx: Ctx): Promise<void> {
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      ctx.log.error({ err, step: name }, 'phase pass step failed');
    }
  };
  await step('merge checks', () => mergeChecks(ctx));
  await step('release checks', () => releaseChecks(ctx));
  await step('completion', () => completionStep(ctx));
  await step('results', () => resultsStep(ctx));
  await step('sequencing', () => sequenceStep(ctx));
  // a recipe project's deploy follow-up that just started asks for its run in the same pass
  await step('deploys', () => deployStep(ctx));
}

// ------------------------------------------------------------------------------ merge checks (A2)

/**
 * A finalized `pr` / `push_branch` card of an open phase counts once its branch is merged into the working branch.
 * The runner of the card's home workstation checks it with git (`branch.check_merged`) and deletes the branch when it
 * is merged; the answer is applied by `applyBranchCheckResult`. One command per card at a time, repeated every
 * `MERGE_CHECK_INTERVAL_SECONDS` while it is not merged.
 */
async function mergeChecks(ctx: Ctx): Promise<void> {
  const due = await rows(
    ctx.pool,
    `SELECT c.*, pr.remote_url_normalized AS repo_remote, ph.working_branch AS phase_branch
       FROM cards c
       JOIN phases ph ON ph.id = c.phase_id AND ph.status = 'open'
       JOIN projects p ON p.id = c.project_id AND p.status = 'active'
       JOIN organizations po ON po.id = p.org_id AND po.status IN ('trial','active')
       JOIN project_repos pr ON pr.id = c.repo_id
      WHERE c.phase_assignment = 'confirmed' AND c.status = 'done' AND c.finalize_result IS NOT NULL
        AND c.finalize_action IN ('pr','push_branch') AND c.merged_into_working_at IS NULL
        AND c.branch_name IS NOT NULL AND c.home_workstation_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM runner_commands rc
           WHERE rc.type = 'branch.check_merged' AND rc.payload->>'cardId' = c.id::text
             AND (rc.status IN ('pending','sent') OR rc.created_at > now() - make_interval(secs => $1)))`,
    [mergeCheckSeconds()],
  );
  const touched = new Set<string>();
  for (const c of due) {
    const branch = await workingBranchOf(
      ctx.pool,
      c,
      c.phase_branch ? { working_branch: c.phase_branch } : null,
    );
    await enqueueRunnerCommand(ctx.pool, c.home_workstation_id, 'branch.check_merged', {
      cardId: c.id,
      ref: c.ref,
      repoId: c.repo_id,
      remoteUrlNormalized: c.repo_remote,
      branchName: c.branch_name,
      workingBranch: branch,
      action: c.finalize_action,
    });
    touched.add(c.home_workstation_id);
  }
  for (const ws of touched) await ctx.services.gateway.deliverPending(ws);
}

// -------------------------------------------------------------------------------------- completion

/** An open phase whose members all ended (and merged) is complete: the BA is asked to report it. */
async function completionStep(ctx: Ctx): Promise<void> {
  const open = await rows(
    ctx.pool,
    `SELECT ph.id FROM phases ph JOIN projects p ON p.id = ph.project_id AND p.status = 'active' AND p.paused_at IS NULL
       JOIN organizations po ON po.id = p.org_id AND po.status IN ('trial','active')
      WHERE ph.status = 'open' AND EXISTS (SELECT 1 FROM cards c WHERE c.phase_id = ph.id AND c.phase_assignment = 'confirmed')
      ORDER BY ph.created_at`,
  );
  for (const { id } of open) {
    await inTx(ctx, 'completion', async (tx) => {
      const phase = await one(tx, `SELECT * FROM phases WHERE id=$1 AND status='open' FOR UPDATE`, [id]);
      if (!phase) return;
      const members = await memberRows(tx, phase.id);
      if (phaseCompletion(members.map(memberState)) !== 'complete') return;
      const outcomes = await cardOutcomes(tx, phase.id);
      const task = await queueBaTask(tx, phase, 'phase_report');
      const delivered = outcomes.filter((o) => o.outcome !== 'cancelled').length;
      await ctx.store.append(
        [
          {
            streamId: streamId.phase(phase.id),
            event: {
              type: 'PhaseCompleted',
              payload: { phaseId: phase.id, cardOutcomes: outcomes, baTaskId: task.taskId },
            },
            actor: SYSTEM_ACTOR,
            scope: phaseScope(phase),
          },
          task.event,
          phaseMessage(
            phase,
            { kind: 'system' },
            `Every card of the phase has ended${delivered === 0 ? ' (nothing was delivered: all were cancelled)' : ' and its work is merged into the working branch'}. The BA is writing the report.`,
          ),
        ],
        { tx },
      );
    });
  }
}

// ------------------------------------------------------------------------------------------ recipe deploys

/**
 * A running deploy follow-up of a recipe project asks for its deploy run (outside the phase transaction: the request takes
 * its own). Once a run row exists for the follow-up, even a refused one, it is never asked for again; `followupVerdict` reads
 * the runs.
 */
async function deployStep(ctx: Ctx): Promise<void> {
  const waiting = await rows(
    ctx.pool,
    `SELECT f.id, f.phase_id, f.target_id, f.environment, ph.project_id, t.name AS target_name FROM phase_followups f
       JOIN phases ph ON ph.id = f.phase_id AND ph.status = 'running_followups'
       JOIN projects p ON p.id = ph.project_id AND p.status = 'active' AND p.delivery_mode = 'recipe'
       LEFT JOIN deploy_targets t ON t.id = f.target_id
      WHERE f.status = 'running' AND f.kind = 'deploy' AND f.devops_request_ids = '{}'
        AND NOT EXISTS (SELECT 1 FROM deploy_runs r WHERE r.phase_followup_id = f.id AND NOT r.trial)
      ORDER BY f.phase_id, f.position`,
  );
  for (const f of waiting) {
    const rec = await one(ctx.pool, `SELECT approved_parsed FROM delivery_recipes WHERE project_id=$1`, [
      f.project_id,
    ]);
    const env = (rec?.approved_parsed as Recipe | null)?.environments.find((e) =>
      f.environment
        ? e.name === f.environment
        : e.targets.some((t) => t.toLowerCase() === String(f.target_name).toLowerCase()),
    );
    if (!env) continue;
    await requestDeployRun(ctx, {
      projectId: f.project_id,
      env: env.name,
      ...(f.environment ? {} : { targets: [f.target_name] }),
      trigger: 'request',
      requester: { kind: 'trigger', id: null, name: 'phase follow-up', provenance: 'trigger' },
      phaseFollowupId: f.id,
    });
  }
}

// ----------------------------------------------------------------------------------------- results

/** Maps the state of a running follow-up's delegate (DevOps requests, regression cards) to its result. */
async function resultsStep(ctx: Ctx): Promise<void> {
  const running = await rows(
    ctx.pool,
    `SELECT f.id, f.phase_id FROM phase_followups f JOIN phases ph ON ph.id = f.phase_id AND ph.status = 'running_followups'
       JOIN projects p ON p.id = ph.project_id AND p.status = 'active'
       JOIN organizations po ON po.id = p.org_id AND po.status IN ('trial','active')
      WHERE f.status = 'running' AND f.delegate IN ('devops','tester') ORDER BY f.phase_id, f.position`,
  );
  for (const r of running) {
    await inTx(ctx, 'phase', async (tx) => {
      const phase = await one(
        tx,
        `SELECT * FROM phases WHERE id=$1 AND status='running_followups' FOR UPDATE`,
        [r.phase_id],
      );
      const f = await one(tx, `SELECT * FROM phase_followups WHERE id=$1 AND status='running'`, [r.id]);
      if (!phase || !f) return;
      const verdict = await followupVerdict(tx, f);
      if (!verdict) return;
      await ctx.store.append(
        [
          followupFinishedEvent(phase, f.id, verdict.status, verdict.summary, verdict.evidence),
          phaseMessage(
            phase,
            { kind: 'system' },
            `Follow-up ${f.position} ${verdict.status}: ${verdict.summary}`,
            { followupId: f.id },
          ),
        ],
        { tx },
      );
    });
  }
}

// ------------------------------------------------------------------------------------ sequencing

/** Starts the next briefed follow-up, skips what a failure stopped, and finishes the phase when all are terminal. */
async function sequenceStep(ctx: Ctx): Promise<void> {
  const active = await rows(
    ctx.pool,
    `SELECT ph.id FROM phases ph JOIN projects p ON p.id = ph.project_id AND p.status = 'active' AND p.paused_at IS NULL
       JOIN organizations po ON po.id = p.org_id AND po.status IN ('trial','active')
      WHERE ph.status = 'running_followups' ORDER BY ph.approved_at`,
  );
  for (const { id } of active) {
    await inTx(ctx, 'phase', async (tx) => {
      const phase = await one(
        tx,
        `SELECT * FROM phases WHERE id=$1 AND status='running_followups' FOR UPDATE`,
        [id],
      );
      if (!phase) return;
      const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [phase.project_id]);
      if (!project) return;
      let list = await followupRows(tx, phase.id);
      if (list.some((f) => f.status === 'running')) return;
      const next = nextFollowup(list.map((f) => ({ id: f.id, position: f.position, status: f.status })));
      if (next.skip.length) {
        const failed = list.find((f) => f.status === 'failed');
        await ctx.store.append(
          next.skip.flatMap((fid) => [
            followupFinishedEvent(
              phase,
              fid,
              'skipped',
              `skipped: follow-up ${failed?.position ?? '?'} failed, so the ones after it do not run`,
            ),
          ]),
          { tx },
        );
        list = await followupRows(tx, phase.id);
      }
      if (next.start) {
        const f = list.find((x) => x.id === next.start);
        if (f) await startFollowup(ctx, tx, phase, project, f);
        list = await followupRows(tx, phase.id);
      }
      if (list.length && list.every((f) => isFollowupTerminal(f.status))) {
        const failed = list.some((f) => f.status === 'failed');
        const task = await queueBaTask(tx, phase, 'followups_report');
        await ctx.store.append(
          [
            {
              streamId: streamId.phase(phase.id),
              event: {
                type: 'PhaseFollowupsFinished',
                payload: {
                  phaseId: phase.id,
                  status: failed ? 'done_with_failures' : 'done',
                  baTaskId: task.taskId,
                },
              },
              actor: SYSTEM_ACTOR,
              scope: phaseScope(phase),
            },
            task.event,
            phaseMessage(
              phase,
              { kind: 'system' },
              failed
                ? 'The follow-ups finished with failures. The BA is writing the results report.'
                : 'All follow-ups succeeded. The BA is writing the results report.',
            ),
          ],
          { tx },
        );
      }
    });
  }
}
