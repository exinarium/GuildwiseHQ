import {
  type RepoBumpSubmodulePayload,
  RepoBumpSubmoduleResultSchema,
  runnerAtLeast,
  type Trigger,
} from '@aom/shared';
import { loadCommitAs } from '../commands/commit-as.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { MERGE_DEBOUNCE_MS } from './debounce.ts';
import { latestMerge } from './gate.ts';
import { raiseDeskNotice } from './notices.ts';
import { type EnvRepo, requestDeployRun } from './runs.ts';

/**
 * A card merged into repository X, and the deploy repository D of an `after_merge` environment is another repository that
 * holds X as a git submodule: D deploys X's code only once D's pin of X names the merge. The server asks a workstation
 * that holds D to move the pin (`repo.bump_submodule`: a commit on D's working branch and a push), and deploys the commit
 * the workstation answers with. The server cannot read `.gitmodules`; the workstation does, so "D does not contain X"
 * comes back as an answer (`notSubmodule`) and D is then deployed as it is.
 */

/** The first runner that has `repo.bump_submodule`. */
export const MIN_RUNNER_FOR_SUBMODULE_PIN = '0.1.64';
const PIN_COMMAND_TTL_MS = 3_600_000;

export const pinSubject = (projectId: string, repoId: string) => `submodule_pin:${projectId}:${repoId}`;

export type PinRequest =
  /** The command is on its way; the deploy follows its answer. */
  | 'sent'
  /** Not asked (nothing merged in X, X is gone): the caller deploys D as it is. */
  | 'skipped'
  /** No workstation with D has a runner that can do it: the caller deploys D as it is (a notice was raised). */
  | 'unsupported';

async function repoById(db: Queryable, projectId: string, repoId: string) {
  return one<{ id: string; name: string; remote_url_normalized: string }>(
    db,
    `SELECT id, name, remote_url_normalized FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL`,
    [repoId, projectId],
  );
}

/**
 * Asks for D's pin of X to be moved to X's newest merge. `deployRepo` is D, `envs` the environments to deploy afterwards
 * (all of them deploy D). Never throws for an unavailable workstation: the answer says what the caller does instead.
 */
export async function requestSubmodulePin(
  ctx: Ctx,
  p: {
    projectId: string;
    deployRepo: EnvRepo;
    sourceRepoId: string;
    envs: string[];
    trigger: Trigger;
  },
): Promise<PinRequest> {
  const source = await repoById(ctx.pool, p.projectId, p.sourceRepoId);
  const merge = await latestMerge(ctx.pool, p.projectId, p.sourceRepoId);
  if (!source || !merge) return 'skipped';
  const project = await one(
    ctx.pool,
    `SELECT org_id, key, working_branch FROM projects WHERE id=$1 AND kind='project'`,
    [p.projectId],
  );
  if (!project) return 'skipped';
  const workingBranch = p.deployRepo.working_branch ?? project.working_branch;
  if (!workingBranch) return 'skipped';

  const holders = await rows(
    ctx.pool,
    `SELECT w.id, w.runner_version FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
      WHERE wr.project_repo_id=$1 AND w.status='active'
      ORDER BY w.connected DESC, w.last_seen_at DESC NULLS LAST`,
    [p.deployRepo.id],
  );
  const ws = holders.find((h) => runnerAtLeast(h.runner_version, MIN_RUNNER_FOR_SUBMODULE_PIN));
  if (!ws) {
    // Nobody holds D: the deploy itself reports it (no workstation). An older runner only: say why the pin stays.
    if (holders.length > 0)
      await raiseDeskNotice(ctx, {
        orgId: project.org_id,
        projectId: p.projectId,
        subkind: 'submodule_pin',
        subjectKey: pinSubject(p.projectId, p.deployRepo.id),
        title: `${project.key}: the ${source.name} pin in ${p.deployRepo.name} was not updated`,
        body: `A card merged into ${source.name}. ${p.deployRepo.name} was deployed as it is, because the runner on its workstation (${holders[0]?.runner_version ?? 'unknown version'}) is older than ${MIN_RUNNER_FOR_SUBMODULE_PIN} and cannot move a submodule pin. Update the runner, or move the pin by hand.`,
        data: { projectId: p.projectId, repoId: p.deployRepo.id, sourceRepoId: source.id },
      });
    return 'unsupported';
  }

  const commitAs = await loadCommitAs(ctx.pool, p.projectId);
  const payload: RepoBumpSubmodulePayload = {
    projectId: p.projectId,
    repoId: p.deployRepo.id,
    remoteUrlNormalized: p.deployRepo.remote_url_normalized,
    workingBranch,
    sourceRepoId: source.id,
    submoduleRemoteUrlNormalized: source.remote_url_normalized,
    commit: merge.commit,
    ...(commitAs ? { commitAs } : {}),
    ...(p.deployRepo.forge_kind
      ? { forge: p.deployRepo.forge_kind as RepoBumpSubmodulePayload['forge'] }
      : {}),
    envs: p.envs,
    trigger: p.trigger,
  };
  await enqueueRunnerCommand(
    ctx.pool,
    ws.id,
    'repo.bump_submodule',
    payload as unknown as Record<string, unknown>,
    new Date(ctx.clock.now().getTime() + PIN_COMMAND_TTL_MS),
  );
  void Promise.resolve(ctx.services.gateway.deliverPending(ws.id)).catch(() => undefined);
  return 'sent';
}

/**
 * `command.result` of `repo.bump_submodule`. Pinned (or already pinned): D's environments deploy the commit it answered
 * with. D does not hold X as a submodule: D deploys as it is. Anything else (a refused push, a conflict, no clone): a desk
 * notice with the runner's words, and no deploy, because the deploy would run code that does not match the merge.
 */
export async function applySubmodulePinResult(
  ctx: Ctx,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const projectId = String(payload.projectId ?? '');
  const repoId = String(payload.repoId ?? '');
  const envs = Array.isArray(payload.envs) ? (payload.envs as string[]) : [];
  const trigger = (typeof payload.trigger === 'string' ? payload.trigger : 'after_merge') as Trigger;
  const parsed = RepoBumpSubmoduleResultSchema.safeParse(result);
  const r = ok && parsed.success ? parsed.data : undefined;
  const requester = { kind: 'trigger', id: null, name: trigger, provenance: 'trigger' } as const;
  const deploy = async (commit: string | undefined, pinned: boolean) => {
    let inProgress = false;
    for (const env of envs) {
      const res = await requestDeployRun(ctx, {
        projectId,
        env,
        ...(commit ? { commit, pinnedCommit: pinned } : {}),
        trigger,
        requester,
      }).catch((err) => {
        ctx.log.warn({ err }, 'deploy after a submodule pin failed');
        return null;
      });
      if (res?.runs.some((x) => x.refusal === 'run_in_progress')) inProgress = true;
    }
    // A deploy of this environment is running: ask again once it settles (the pin is already there, the answer is "unchanged").
    if (inProgress && typeof payload.sourceRepoId === 'string')
      await exec(
        ctx.pool,
        `INSERT INTO deploy_trigger_queue (project_id, trigger, commit, repo_id, repo_ids, due_at, created_at)
         VALUES ($1,$2,NULL,$3,ARRAY[$3]::uuid[],$4,$5) ON CONFLICT (project_id, trigger) DO NOTHING`,
        [
          projectId,
          trigger,
          payload.sourceRepoId,
          new Date(ctx.clock.now().getTime() + MERGE_DEBOUNCE_MS),
          ctx.clock.now(),
        ],
      );
  };

  if (r?.ok && r.commit) {
    ctx.log.info({ projectId, repoId, commit: r.commit, unchanged: r.unchanged }, 'submodule pin ready');
    await deploy(r.commit, true);
    return;
  }
  if (r?.notSubmodule) {
    await deploy(undefined, false);
    return;
  }
  const project = await one(ctx.pool, `SELECT org_id, key FROM projects WHERE id=$1`, [projectId]);
  if (!project) return;
  const repo = await repoById(ctx.pool, projectId, repoId);
  const why = r?.error ?? error ?? 'the workstation could not move the pin';
  await raiseDeskNotice(ctx, {
    orgId: project.org_id,
    projectId,
    subkind: 'submodule_pin',
    subjectKey: pinSubject(projectId, repoId),
    title: `${project.key}: the pin in ${repo?.name ?? 'the deploy repository'} could not be updated`,
    body: `A card merged, but ${repo?.name ?? 'the deploy repository'} could not be pointed at the merge, so ${envs.join(', ') || 'the environment'} was not deployed (it would run code that does not match the merge). ${why}${r?.protectedBranch ? ' The working branch is protected: let the runner push to it, or move the pin by hand.' : ''}`,
    data: { projectId, repoId, error: why },
  });
}
