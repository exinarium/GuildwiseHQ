import type { Recipe, Trigger } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { MERGE_DEBOUNCE_MS } from './debounce.ts';
import { type EnvRepo, envRepo, requestDeployRun, sweepExpiredDeploys } from './runs.ts';
import { requestSubmodulePin } from './submodule-pin.ts';

export { MERGE_DEBOUNCE_MS };

const hasTrigger = (recipe: Recipe | null, trigger: Trigger): boolean =>
  !!recipe?.environments.some((e) => e.triggers.includes(trigger));

/**
 * `CardFinalized` with a merge commit: a recipe project with an `after_merge` environment waits two minutes (the newest
 * commit replaces the older one) and then asks for a deploy. The queue remembers the repository of the card (a commit only
 * means something in its own repository). Never throws: a missed trigger is a deploy the Owner asks for.
 */
export async function queueMergeTrigger(ctx: Ctx, cardId: string, mergeCommit: string): Promise<boolean> {
  const card = await one(
    ctx.pool,
    `SELECT c.project_id, c.repo_id FROM cards c JOIN projects p ON p.id = c.project_id
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
    `INSERT INTO deploy_trigger_queue (project_id, trigger, commit, repo_id, repo_ids, due_at, created_at)
     VALUES ($1,'after_merge',$2,$3,CASE WHEN $3::uuid IS NULL THEN '{}'::uuid[] ELSE ARRAY[$3::uuid] END,$4,$5)
     ON CONFLICT (project_id, trigger) DO UPDATE SET commit=EXCLUDED.commit, repo_id=EXCLUDED.repo_id,
       repo_ids=(SELECT COALESCE(array_agg(DISTINCT x), '{}') FROM unnest(deploy_trigger_queue.repo_ids || EXCLUDED.repo_ids) x),
       due_at=EXCLUDED.due_at`,
    [card.project_id, mergeCommit, card.repo_id ?? null, new Date(now.getTime() + MERGE_DEBOUNCE_MS), now],
  );
  return true;
}

/**
 * Due triggers become deploy requests, and deploys nobody collected expire. Called from every dispatch pass.
 *
 * For each environment that lists the trigger: the repository it deploys (D) is compared with the repositories that merged
 * in the burst. Merges only in D (or none known, rows from before repositories were remembered): D is deployed with the
 * newest commit, as before. Merges in another repository X: the commit is X's, never D's, so D is not asked to deploy it;
 * a runner moves D's pin of X (`repo.bump_submodule`) and the deploy follows its answer. A runner that cannot do that, or
 * a pin that is not there to move, leaves D deployed as it is.
 */
export async function deliveryPass(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const due = await rows(
    ctx.pool,
    `DELETE FROM deploy_trigger_queue WHERE due_at <= $1 RETURNING project_id, trigger, commit, repo_id, repo_ids`,
    [now],
  );
  for (const d of due) {
    const rec = await one(ctx.pool, `SELECT approved_parsed FROM delivery_recipes WHERE project_id=$1`, [
      d.project_id,
    ]);
    const recipe = (rec?.approved_parsed ?? null) as Recipe | null;
    const merged: string[] = [...new Set<string>([...(d.repo_ids ?? []), ...(d.repo_id ? [d.repo_id] : [])])];
    const deploy = async (envName: string, commit: string | null) => {
      const r = await requestDeployRun(ctx, {
        projectId: d.project_id,
        env: envName,
        commit,
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
          `INSERT INTO deploy_trigger_queue (project_id, trigger, commit, repo_id, repo_ids, due_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (project_id, trigger) DO NOTHING`,
          [
            d.project_id,
            d.trigger,
            d.commit,
            d.repo_id,
            merged,
            new Date(now.getTime() + MERGE_DEBOUNCE_MS),
            now,
          ],
        );
    };
    // (deploy repository, merged repository) -> the environments to deploy once the pin is moved
    const pins = new Map<string, { repo: EnvRepo; source: string; envs: string[] }>();
    for (const env of recipe?.environments.filter((e) => e.triggers.includes(d.trigger)) ?? []) {
      const repo = merged.length ? await envRepo(ctx.pool, d.project_id, env.repo) : null;
      const sources = repo ? merged.filter((id) => id !== repo.id) : [];
      if (!repo || sources.length === 0) {
        await deploy(env.name, d.commit);
        continue;
      }
      for (const source of sources) {
        const key = `${repo.id}:${source}`;
        const g = pins.get(key) ?? { repo, source, envs: [] };
        g.envs.push(env.name);
        pins.set(key, g);
      }
    }
    for (const g of pins.values()) {
      const sent = await requestSubmodulePin(ctx, {
        projectId: d.project_id,
        deployRepo: g.repo,
        sourceRepoId: g.source,
        envs: g.envs,
        trigger: d.trigger,
      }).catch((err) => {
        ctx.log.warn({ err }, 'submodule pin request failed');
        return 'unsupported' as const;
      });
      // Not asked: D is deployed as it is, with the newest merge of D itself (or its working branch head), never X's commit.
      if (sent !== 'sent') for (const env of g.envs) await deploy(env, null);
    }
  }
  await sweepExpiredDeploys(ctx);
}
