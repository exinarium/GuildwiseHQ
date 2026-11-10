import { type Recipe, streamId } from '@aom/shared';
import { cardMessage, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { createDevOpsRequestIn } from '../commands/devops.ts';
import { regressionRunEvents } from '../commands/regression.ts';
import {
  loopStoppedEvents,
  REGRESSION_LOOP_MAX_RUNS,
  safeBranch,
  safeSha,
} from '../commands/regression-loop.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';

/**
 * The regression loop (DESIGN P4): once every bug of a failed regression run is merged, the DevOps engineer of the
 * workstation that ran it redeploys the app under test; when that is done the run starts again. Each step locks the
 * loop row and re-checks its state, so a pass is idempotent (and only the dispatcher holding the lock runs it).
 */
export async function regressionLoopPass(ctx: Ctx): Promise<void> {
  await switchedOffStep(ctx);
  await redeployDueStep(ctx);
  await redeployFinishedStep(ctx);
}

/** Locks the loop row; null when it is no longer in one of `states`. */
async function lockLoop(tx: Tx, runCardId: string, states: string[]): Promise<Row | null> {
  const l = await one(tx, 'SELECT * FROM regression_loops WHERE run_card_id=$1 FOR UPDATE', [runCardId]);
  return l && states.includes(l.state) ? l : null;
}

const runCard = (tx: Tx, id: string) =>
  one(tx, 'SELECT id, ref, org_id, project_id, owner_user_id, fields FROM cards WHERE id=$1', [id]);

/** 1. The switch was turned off: open loops stop quietly (a message on the run). */
async function switchedOffStep(ctx: Ctx): Promise<void> {
  const open = await rows(
    ctx.pool,
    `SELECT l.run_card_id FROM regression_loops l JOIN projects p ON p.id = l.project_id
      WHERE l.state IN ('waiting_fixes','redeploying') AND NOT p.regression_loop`,
  );
  for (const o of open)
    await withAppendTx(ctx.pool, async (tx) => {
      const l = await lockLoop(tx, o.run_card_id, ['waiting_fixes', 'redeploying']);
      if (!l) return;
      const p = await one(tx, 'SELECT regression_loop FROM projects WHERE id=$1', [l.project_id]);
      if (p?.regression_loop) return;
      const run = await runCard(tx, l.run_card_id);
      if (!run) return;
      await ctx.store.append(
        loopStoppedEvents(
          run,
          'switched_off',
          'The regression loop was switched off for this project: no rerun.',
          {
            quiet: true,
            ...(l.devops_request_id ? { requestId: l.devops_request_id } : {}),
          },
        ),
        { tx },
      );
    });
}

/** The bugs a loop row waits for: every bug card the run reported (filed or seen again). */
const linkedBugs = (tx: Tx, runCardId: string) =>
  rows(
    tx,
    `SELECT bc.id, bc.ref, bc.status, bc.merged_into_working_at, bc.base_branch FROM suite_run_bugs b
       JOIN cards bc ON bc.id = b.bug_card_id WHERE b.run_card_id=$1 ORDER BY bc.number`,
    [runCardId],
  );

/** 2. Every bug merged (or cancelled, at least one merged) or the run declared a stale target: ask DevOps to redeploy. */
async function redeployDueStep(ctx: Ctx): Promise<void> {
  const due = await rows(
    ctx.pool,
    `SELECT l.run_card_id FROM regression_loops l JOIN projects p ON p.id = l.project_id
      WHERE l.state = 'waiting_fixes' AND p.regression_loop AND p.status = 'active' AND p.paused_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM suite_run_bugs b JOIN cards bc ON bc.id = b.bug_card_id
                         WHERE b.run_card_id = l.run_card_id AND bc.merged_into_working_at IS NULL
                           AND bc.status <> 'cancelled')`,
  );
  for (const d of due)
    await withAppendTx(ctx.pool, async (tx) => {
      const l = await lockLoop(tx, d.run_card_id, ['waiting_fixes']);
      if (!l) return;
      const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [l.project_id]);
      if (!project?.regression_loop || project.status !== 'active' || project.paused_at) return;
      const run = await runCard(tx, l.run_card_id);
      if (!run) return;
      const bugs = await linkedBugs(tx, l.run_card_id);
      if (bugs.some((b) => !b.merged_into_working_at && b.status !== 'cancelled')) return;
      const merged = bugs.filter((b) => b.merged_into_working_at);
      if (!l.mismatch && merged.length === 0) {
        await ctx.store.append(
          loopStoppedEvents(
            run,
            'bugs_cancelled',
            `Every bug card ${run.ref} filed was cancelled, none merged: the regression loop stops. Start the regression by hand when you want it again.`,
          ),
          { tx },
        );
        return;
      }
      const recipeEnv = await recipeEnvironmentOf(tx, project, run);
      if (recipeEnv) {
        await ctx.store.append(
          loopStoppedEvents(
            run,
            'recipe_deploy',
            `${project.key} deploys through its delivery recipe, so the regression loop does not ask DevOps to redeploy. Deploy ${recipeEnv} from the release queue, then start the regression run.`,
          ),
          { tx },
        );
        return;
      }
      const summary = await redeploySummary(tx, project, run, merged);
      let requestId: string;
      try {
        if (!l.workstation_id) throw new Error('the workstation of the run is unknown');
        ({ requestId } = await createDevOpsRequestIn(ctx, tx, {
          workstationId: l.workstation_id,
          orgId: project.org_id,
          // No card link: the DevOps brief would carry the run card's thread, which holds tester text (the paused
          // project hold works through the context's project, as for phase follow-ups).
          requestedBy: { kind: 'system', id: null, name: 'Regression loop' },
          context: { projectId: project.id },
          summary: summary.text,
        }));
      } catch (err) {
        await ctx.store.append(
          loopStoppedEvents(
            run,
            'no_devops',
            `The regression loop could not ask a DevOps engineer to redeploy the app that ${run.ref} tested (${err instanceof Error ? err.message : String(err)}). Redeploy it, then start the regression by hand.`,
          ),
          { tx },
        );
        return;
      }
      await ctx.store.append(
        [
          {
            streamId: streamId.card(run.id),
            event: {
              type: 'RegressionRedeployRequested',
              payload: {
                runCardId: run.id,
                projectId: project.id,
                requestId,
                workstationId: l.workstation_id,
                mergedBugCardIds: merged.map((b) => b.id),
                ...(summary.baseBranch ? { baseBranch: summary.baseBranch } : {}),
                ...(summary.mergeCommit ? { mergeCommit: summary.mergeCommit } : {}),
              },
            },
            actor: SYSTEM_ACTOR,
            scope: projectScope(project.org_id, project.id),
          },
          cardMessage(
            run,
            { kind: 'system' },
            'system',
            `${l.mismatch ? 'The target ran another build' : `The bugs of this run are merged (${merged.map((b) => b.ref).join(', ')})`}: the DevOps engineer is asked to redeploy the app (request ${requestId.slice(0, 8)}). The regression runs again when it reports done.`,
            { requestId },
          ),
        ],
        { tx },
      );
    });
}

/** A recipe project whose run names a deploy target of an approved recipe environment: that environment's name. */
async function recipeEnvironmentOf(tx: Tx, project: Row, run: Row): Promise<string | null> {
  if (project.delivery_mode !== 'recipe') return null;
  const target = run.fields?.deployTarget;
  if (typeof target !== 'string' || !target) return null;
  const rec = await one(tx, 'SELECT approved_parsed, status FROM delivery_recipes WHERE project_id=$1', [
    project.id,
  ]);
  if (rec?.status !== 'approved') return null;
  const env = (rec.approved_parsed as Recipe | null)?.environments.find((e) =>
    e.targets.some((t) => t.toLowerCase() === target.toLowerCase()),
  );
  return env?.name ?? null;
}

/**
 * The DevOps request text. Fixed wording and checked values only (refs, a plain branch name, hex shas, the card's
 * validated target URL): never text a tester wrote, which would be a prompt-injection path into a privileged agent.
 */
async function redeploySummary(
  tx: Tx,
  project: Row,
  run: Row,
  merged: Row[],
): Promise<{ text: string; baseBranch: string | null; mergeCommit: string | null }> {
  const baseBranch = safeBranch(merged.find((b) => b.base_branch)?.base_branch) ?? null;
  const merge = await one(
    tx,
    `SELECT e.payload->'resultRef'->>'mergeCommit' AS commit FROM events e
      WHERE e.type='CardFinalized' AND e.payload->>'cardId' = ANY($1::text[])
        AND e.payload->'resultRef'->>'mergeCommit' IS NOT NULL
      ORDER BY e.seq DESC LIMIT 1`,
    [merged.map((b) => String(b.id))],
  );
  const mergeCommit = safeSha(merge?.commit);
  const platform = run.fields?.platform === 'mobile' ? 'mobile' : 'web';
  const url =
    typeof run.fields?.targetUrl === 'string' && /^https?:\/\/\S+$/.test(run.fields.targetUrl)
      ? run.fields.targetUrl
      : null;
  const branch = baseBranch ?? 'the base branch';
  const fixes = merged.length
    ? `The fixes for ${merged.map((b) => b.ref).join(', ')} are merged into ${branch}${mergeCommit ? ` (newest merge ${mergeCommit.slice(0, 12)})` : ''}.`
    : `The last run of ${run.ref} found the app running an older build than the one it tested.`;
  const text = [
    `Redeploy the app under test for ${project.key} so the ${platform} regression can run again. ${fixes}`,
    `Rebuild and restart the app that ${run.ref} tested on this workstation${url ? `, at ${url}` : ''}, from the head of ${branch}, and check that it answers.`,
    'Then report with `aom devops-done --summary` stating the deployed commit as `Deployed commit: <full sha>` and the URL you verified. The regression starts again only after you report done.',
  ].join('\n\n');
  return { text, baseBranch, mergeCommit };
}

/** 3. The redeploy request ended: on done queue the next run, on failed stop with an alert. */
async function redeployFinishedStep(ctx: Ctx): Promise<void> {
  const finished = await rows(
    ctx.pool,
    `SELECT l.run_card_id FROM regression_loops l JOIN devops_requests d ON d.id = l.devops_request_id
      WHERE l.state = 'redeploying' AND d.status IN ('done','failed')`,
  );
  for (const f of finished)
    await withAppendTx(ctx.pool, async (tx) => {
      const l = await lockLoop(tx, f.run_card_id, ['redeploying']);
      if (!l) return;
      const d = await one(tx, 'SELECT id, status, result_summary FROM devops_requests WHERE id=$1', [
        l.devops_request_id,
      ]);
      if (!d || !['done', 'failed'].includes(d.status)) return;
      const run = await runCard(tx, l.run_card_id);
      if (!run) return;
      const summary = String(d.result_summary ?? '');
      if (d.status === 'failed') {
        await ctx.store.append(
          loopStoppedEvents(
            run,
            'deploy_failed',
            `The DevOps engineer could not redeploy the app for ${run.ref} (request ${String(d.id).slice(0, 8)}): no rerun. Redeploy it, then start the regression by hand.`,
            { detail: summary, requestId: d.id },
          ),
          { tx },
        );
        return;
      }
      const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [l.project_id]);
      if (project && project.status !== 'active') {
        await ctx.store.append(
          loopStoppedEvents(
            run,
            'project_inactive',
            `The project is no longer active: no rerun of ${run.ref}.`,
            {
              quiet: true,
              requestId: d.id,
            },
          ),
          { tx },
        );
        return;
      }
      if (!project?.regression_loop) return; // the switched-off step stops it
      await ctx.store.append(await requeueEvents(tx, project, run, l, d.id, summary), { tx });
    });
}

async function requeueEvents(
  tx: Tx,
  project: Row,
  run: Row,
  l: Row,
  requestId: string,
  summary: string,
): Promise<AppendInput[]> {
  const deployedCommit = safeSha(/Deployed commit:\s*([0-9a-f]{7,40})/i.exec(summary)?.[1]) ?? undefined;
  const iteration = Number(l.iteration) + 1;
  const context = `Regression rerun ${iteration - 1} of ${REGRESSION_LOOP_MAX_RUNS - 1} after ${run.ref}: DevOps redeployed the app${deployedCommit ? `; it reports commit ${deployedCommit}` : ''} (request ${requestId.slice(0, 8)}).`;
  const fields = run.fields ?? {};
  let next: Awaited<ReturnType<typeof regressionRunEvents>>;
  try {
    next = await regressionRunEvents(tx, project, {
      platform: fields.platform === 'mobile' ? 'mobile' : 'web',
      ownerUserId: run.owner_user_id,
      requestedBy: run.owner_user_id,
      actor: SYSTEM_ACTOR,
      scheduled: false,
      startedBy: 'the regression loop',
      extra: {
        ...(l.workstation_id ? { homeWorkstationId: l.workstation_id } : {}),
        fields: {
          context,
          ...(fields.targetUrl ? { targetUrl: fields.targetUrl } : {}),
          ...(fields.deployTarget ? { deployTarget: fields.deployTarget } : {}),
        },
      },
    });
  } catch (err) {
    return loopStoppedEvents(
      run,
      'requeue_failed',
      `The app was redeployed, but the regression loop could not start the next run of ${run.ref} (${err instanceof Error ? err.message : String(err)}). Start it by hand.`,
      { requestId },
    );
  }
  const card = next.cards[0] as { id: string; ref: string };
  return [
    ...next.events,
    {
      streamId: streamId.card(run.id),
      event: {
        type: 'RegressionRequeued',
        payload: {
          runCardId: run.id,
          projectId: project.id,
          requestId,
          nextCardId: card.id,
          iteration,
          ...(deployedCommit ? { deployedCommit } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(project.org_id, project.id),
    },
    cardMessage(run, { kind: 'system' }, 'system', `The app was redeployed: rerun ${card.ref} is queued.`, {
      nextCardId: card.id,
    }),
  ];
}
