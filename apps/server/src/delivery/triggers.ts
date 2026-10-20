import type { Recipe, Trigger } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { requestDeployRun, sweepExpiredDeploys } from './runs.ts';

/** A burst of merges deploys once: the newest commit wins after this long (docs/design/ceo-front-door.md 9.5). */
export const MERGE_DEBOUNCE_MS = 2 * 60_000;

const hasTrigger = (recipe: Recipe | null, trigger: Trigger): boolean =>
  !!recipe?.environments.some((e) => e.triggers.includes(trigger));

/**
 * `CardFinalized` with a merge commit: a recipe project with an `after_merge` environment waits two minutes (the newest
 * commit replaces the older one) and then asks for a deploy. Never throws: a missed trigger is a deploy the Owner asks for.
 */
export async function queueMergeTrigger(ctx: Ctx, cardId: string, mergeCommit: string): Promise<boolean> {
  const card = await one(
    ctx.pool,
    `SELECT c.project_id FROM cards c JOIN projects p ON p.id = c.project_id
      WHERE c.id=$1 AND p.kind='project' AND p.delivery_mode='recipe'`,
    [cardId],
  );
  if (!card) return false;
  const rec = await one(
    ctx.pool,
    `SELECT approved_parsed FROM delivery_recipes WHERE project_id=$1 AND status='approved'`,
    [card.project_id],
  );
  if (!hasTrigger((rec?.approved_parsed ?? null) as Recipe | null, 'after_merge')) return false;
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `INSERT INTO deploy_trigger_queue (project_id, trigger, commit, due_at, created_at) VALUES ($1,'after_merge',$2,$3,$4)
     ON CONFLICT (project_id, trigger) DO UPDATE SET commit=EXCLUDED.commit, due_at=EXCLUDED.due_at`,
    [card.project_id, mergeCommit, new Date(now.getTime() + MERGE_DEBOUNCE_MS), now],
  );
  return true;
}

/** Due triggers become deploy requests, and deploys nobody collected expire. Called from every dispatch pass. */
export async function deliveryPass(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const due = await rows(
    ctx.pool,
    `DELETE FROM deploy_trigger_queue WHERE due_at <= $1 RETURNING project_id, trigger, commit`,
    [now],
  );
  for (const d of due) {
    const rec = await one(ctx.pool, `SELECT approved_parsed FROM delivery_recipes WHERE project_id=$1`, [
      d.project_id,
    ]);
    const recipe = (rec?.approved_parsed ?? null) as Recipe | null;
    for (const env of recipe?.environments.filter((e) => e.triggers.includes(d.trigger)) ?? []) {
      const r = await requestDeployRun(ctx, {
        projectId: d.project_id,
        env: env.name,
        commit: d.commit,
        trigger: d.trigger,
        requester: { kind: 'trigger', id: null, name: d.trigger, provenance: 'trigger' },
      }).catch((err) => {
        ctx.log.warn({ err }, 'deploy trigger failed');
        return null;
      });
      // A deploy of this environment is running: the newest merge waits for it (and replaces nothing that is running).
      if (r?.runs.some((x) => x.refusal === 'run_in_progress'))
        await exec(
          ctx.pool,
          `INSERT INTO deploy_trigger_queue (project_id, trigger, commit, due_at, created_at) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (project_id, trigger) DO NOTHING`,
          [d.project_id, d.trigger, d.commit, new Date(now.getTime() + MERGE_DEBOUNCE_MS), now],
        );
    }
  }
  await sweepExpiredDeploys(ctx);
}
