import { randomUUID } from 'node:crypto';
import {
  computerRemovedMessage,
  DELIVERY_CAPABILITY,
  DEPLOYING_COMPUTER_REMOVED,
  type DeployActor,
  type DeployCommitPreview,
  type DeployCommitPreviewQuery,
  type DeployCommitSource,
  type DeployExecPayload,
  DeployExecResultSchema,
  type DeployRunCommitSource,
  type Gate,
  type GateEvidence,
  MOVE_OPEN_STATES,
  maskText,
  type Recipe,
  type RecipeEnv,
  streamId,
  type Trigger,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { enqueueWake } from '../ceo/wakes.ts';
import { projectScope, runnerActor, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx, withTx } from '../db/tx.ts';
import { forbidden, HttpError, notFound, unprocessable } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { workstationServesOrg } from '../simulation/fit.ts';
import type { ProbeAnswer } from './commit-probe.ts';
import { targetComputerRemoved } from './computer-removed.ts';
import { environmentRoles } from './environments.ts';
import { type EnvGateVerdict, effectiveGates, evaluateEnvGate, latestMerge, MERGE_IN_REPO } from './gate.ts';
import { releasesPaused } from './mode.ts';
import { closeDeskNotice, raiseDeskNotice } from './notices.ts';
import { queueReachabilityCheck } from './reachability.ts';
import {
  loadRecipeRow,
  NO_PROJECT_VAULT,
  type ProjectVault,
  projectVault,
  workstationForVault,
} from './recipes.ts';
import { RUNNER_SIGNATURE_REQUIRED, signingGate } from './signing-gate.ts';

/**
 * Deploy runs, server side (docs/design/ceo-front-door.md 9.5 with the Owner's decisions of 14.2).
 *
 * `requestDeployRun` is the ONLY door to a deploy: `aom deploy run`, the Deploy button, the release queue and the triggers all
 * call it. It checks, deterministically and without a model: the recipe is approved at this exact hash, the environment and
 * targets exist, the gate holds. Then the recipe decides WHO releases: the CEO releases only when the recipe names it; the
 * Owner or an Admin always may (the queue's Release button); a rule releases when the recipe says `auto`. A released run
 * becomes a durable `deploy.exec` pinned to the approved hash, which the workstation re-checks and runs outside any model.
 */

export const DEPLOY_EXEC_TTL_MS = 2 * 3_600_000;
const COMMIT_NOT_ALLOWED =
  'this commit is not a merge of the project (the latest merge, a finished card merge, or what an earlier environment runs): ask the Owner to deploy it';
export const DEPLOY_RELEASE_SUBKIND = 'deploy_release';

export interface DeployRequester extends DeployActor {
  provenance?: 'owner' | 'order' | 'wake' | 'session' | 'trigger';
  untrusted?: boolean;
  turnId?: string | undefined;
  wakeBatchId?: string | undefined;
}

export interface RequestDeployInput {
  projectId: string;
  env: string;
  commit?: string | null | undefined;
  /** Target names; absent: every target of the environment. */
  targets?: string[] | undefined;
  trigger: Trigger | 'request';
  requester: DeployRequester;
  trial?: boolean;
  /** A trial that only checks (AOM_DEPLOY_DRY_RUN=1): the guided setup's "Try it without changing anything". */
  dryRun?: boolean;
  phaseFollowupId?: string | undefined;
  reason?: string | undefined;
  /**
   * "Go back to an earlier version": an earlier SUCCESSFUL release of this environment. The gate's test-site, checks and window
   * rules do not apply (the audit says so); a freeze still blocks. Only an Owner or an Admin asks (checked by the caller).
   */
  rollback?: { runId: string; commit: string } | undefined;
  /**
   * `commit` is a commit of the environment's own repository that the server made itself (the head after a submodule pin
   * bump): it is not a card merge, so the allow-list of automated commits does not apply. Set only by the pin-bump result
   * handler, never from a request.
   */
  pinnedCommit?: boolean | undefined;
  /**
   * Server-internal, never from a request body: `commit` is one the server itself already vouched for (a rollback target,
   * the commit of a waiting run that is being released), so it is trusted as it is and recorded with this source.
   */
  commitSource?: DeployRunCommitSource | undefined;
  commitSourceDetail?: string | undefined;
  /** The commit a preview showed. When the default now resolves to another commit the request is refused (409 `commit_moved`). */
  expectCommit?: string | undefined;
}

export interface DeployRunOutcome {
  runId: string;
  target: string;
  /** What became of it: running soon (`queued`: the command is on its way), waiting for a releaser, or refused. */
  status: 'queued' | 'waiting_release' | 'refused';
  waitingFor?: 'owner' | 'ceo';
  refusal?: string;
  detail?: string;
  missing?: string[];
}

export interface RequestDeployResult {
  runs: DeployRunOutcome[];
  message: string;
}

const actorEvent = (a: DeployActor) =>
  a.kind === 'owner' || a.kind === 'admin' ? userActor(a.id as string) : SYSTEM_ACTOR;

const originOf = (r: DeployRequester) => ({
  ...(r.provenance ? { provenance: r.provenance } : {}),
  untrusted: r.untrusted === true,
  ...(r.turnId ? { turnId: r.turnId } : {}),
  ...(r.wakeBatchId ? { wakeBatchId: r.wakeBatchId } : {}),
});

const actorOnly = (r: DeployRequester): DeployActor => ({
  kind: r.kind,
  id: r.id,
  ...(r.name ? { name: r.name } : {}),
});

/** R9 (audit F4): a deploy runs only on a workstation whose user switched the organization on. */
const NOT_SERVING =
  'the workstation that deploys this place does not work for this organization: its owner switches it on under Works for on the Workstations page';

/** Where a target's deploy runs: the local vault's workstation, the remote target's, else a connected one that can read the vault. */
export async function deployWorkstation(
  db: Queryable,
  project: Row,
  vault: ProjectVault,
  target: Row,
): Promise<{ id: string } | { error: string; reason?: string }> {
  // the place's own computer was removed: that comes first, whatever the vault says
  if (await targetComputerRemoved(db, target))
    return { error: computerRemovedMessage(target.name), reason: DEPLOYING_COMPUTER_REMOVED };
  if (vault.storage === 'local') {
    if (target.workstation_id && target.workstation_id !== vault.workstationId)
      return {
        error: `the recipe is in a local vault on another workstation than ${target.name}: give the project a git vault, or deploy from that workstation`,
      };
    const w = await one<{ id: string }>(db, `SELECT id FROM workstations WHERE id=$1 AND status='active'`, [
      vault.workstationId,
    ]);
    if (!w) return { error: 'the workstation that holds the local vault is gone' };
    return (await workstationServesOrg(db, w.id, project.org_id)) ? w : { error: NOT_SERVING };
  }
  if (target.workstation_id) {
    const w = await one<{ id: string }>(db, `SELECT id FROM workstations WHERE id=$1 AND status='active'`, [
      target.workstation_id,
    ]);
    if (!w) return { error: computerRemovedMessage(target.name), reason: DEPLOYING_COMPUTER_REMOVED };
    return (await workstationServesOrg(db, w.id, project.org_id)) ? w : { error: NOT_SERVING };
  }
  const id = await workstationForVault(db, project.id, vault, project.org_id);
  return id ? { id } : { error: 'no workstation of the project can deploy' };
}

async function lacksCapability(db: Queryable, workstationId: string): Promise<boolean> {
  const r = await one<{ capabilities: string[] }>(
    db,
    'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
    [workstationId],
  );
  return !!r && !r.capabilities.includes(DELIVERY_CAPABILITY);
}

/**
 * The repository an environment deploys: the one its recipe names (`repo`), else the first of the project by name. A
 * commit only ever belongs to one repository, so every commit decision about a deploy is made against this one.
 */
export interface EnvRepo {
  id: string;
  name: string;
  remote_url_normalized: string;
  working_branch: string | null;
  forge_kind: string | null;
}

export async function envRepo(
  db: Queryable,
  projectId: string,
  repoName: string | null | undefined,
): Promise<EnvRepo | null> {
  return (
    (await one<EnvRepo>(
      db,
      `SELECT id, name, remote_url_normalized, working_branch, forge_kind FROM project_repos
        WHERE project_id=$1 AND removed_at IS NULL AND ($2::text IS NULL OR lower(name)=lower($2))
        ORDER BY name, id LIMIT 1`,
      [projectId, repoName ?? null],
    )) ?? null
  );
}

export interface ResolvedDeployCommit {
  sha: string;
  shortSha: string;
  subject: string | null;
  author: string | null;
  committedAt: string | null;
  source: DeployCommitSource;
  sourceDetail: string | null;
  branch: string | null;
}

export type DeployCommitFailure =
  /** A commit a person named is not in the repository, or is ambiguous: the request is refused with no run. */
  | { code: 'commit_unknown' | 'commit_ambiguous'; status: 422; message: string }
  /** The tip, the release commit or the promoted commit could not be read on the workstation. */
  | { code: 'commit_unresolved'; status: 409; message: string };

export interface ResolveDeployCommitInput {
  projectId: string;
  projectBranch: string | null;
  envName: string;
  /** The environment's role is `live` (the Environments page rule): it deploys releases. */
  live: boolean;
  repo: EnvRepo | null;
  gates: Array<{ gate: Gate }>;
  /** A commit a person named; absent: the default. */
  explicit: string | null;
  workstationId: string;
  workstationName?: string | undefined;
  /** Answers of one request, so several targets on one workstation ask once. */
  probes?: Map<string, Promise<ProbeAnswer>> | undefined;
}

/** The newest shipped release of a repository: the `chore(release)` commit pushed to the working branch. */
async function newestShippedRelease(
  db: Queryable,
  repoId: string,
): Promise<{ version: string; commit: string } | null> {
  const r = await one(
    db,
    `SELECT version, commit_sha FROM release_ships
      WHERE repo_id=$1 AND status IN ('committed','tagged','published') AND commit_sha IS NOT NULL
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [repoId],
  );
  return r ? { version: r.version, commit: r.commit_sha } : null;
}

/** What an earlier environment runs: the commit an `envHealthy` requirement of the gate points at ("promote what test runs"). */
async function promotedCommit(
  db: Queryable,
  projectId: string,
  gates: Array<{ gate: Gate }>,
): Promise<{ commit: string; fromEnv: string } | null> {
  for (const g of gates)
    for (const r of g.gate.requires)
      if ('envHealthy' in r) {
        const prev = await one(
          db,
          `SELECT COALESCE(deployed_commit, commit) AS commit FROM deploy_runs
            WHERE project_id=$1 AND env=$2 AND status='succeeded' AND NOT trial AND NOT dry_run
            ORDER BY finished_at DESC LIMIT 1`,
          [projectId, r.envHealthy],
        );
        if (prev?.commit) return { commit: prev.commit, fromEnv: r.envHealthy };
      }
  return null;
}

/**
 * The commit a deploy builds, and the ONLY place that decides it (the preview and the deploy both call it, so they cannot
 * disagree). Order: the commit a person named, the newest shipped release (an environment that deploys releases), what an
 * earlier environment runs (a gate's `envHealthy`), the tip of the repository's working branch. The newest card merge is
 * never the default. Every commit goes through the deploying workstation, which holds the clone: the server cannot read git.
 */
export async function resolveDeployCommit(
  ctx: Ctx,
  a: ResolveDeployCommitInput,
): Promise<ResolvedDeployCommit | DeployCommitFailure> {
  const repo = a.repo;
  const branch = repo?.working_branch ?? a.projectBranch ?? null;
  const where = repo?.name ?? 'the repository';
  const unresolved = (message: string): DeployCommitFailure => ({
    code: 'commit_unresolved',
    status: 409,
    message,
  });
  if (!repo)
    return unresolved(`${a.envName} deploys no repository of the project, so there is no commit to read`);
  const probe = (sha: string | null): Promise<ProbeAnswer> => {
    const key = `${a.workstationId}|${repo.remote_url_normalized}|${branch ?? ''}|${sha ?? ''}`;
    let hit = a.probes?.get(key);
    if (!hit) {
      hit = ctx.services.commitProbe.probe(a.workstationId, {
        remoteUrlNormalized: repo.remote_url_normalized,
        branch,
        ...(sha ? { sha } : {}),
      });
      a.probes?.set(key, hit);
    }
    return hit;
  };
  const ws = a.workstationName ? `the workstation ${a.workstationName}` : 'the workstation';
  const fail = (
    ans: Exclude<ProbeAnswer, { kind: 'commit' }>,
    what: string,
    named: string | null,
  ): DeployCommitFailure => {
    switch (ans.kind) {
      case 'offline':
        return unresolved(
          `${ws} that deploys ${a.envName} is offline, so ${what} could not be read; nothing was deployed`,
        );
      case 'outdated':
        return unresolved(`the runner on ${ws} is too old to read the branch: update it, or name a commit`);
      case 'timeout':
        return unresolved(`${ws} did not answer in time, so ${what} could not be read; nothing was deployed`);
      case 'failed':
        if (ans.error === 'ambiguous' && named)
          return {
            code: 'commit_ambiguous',
            status: 422,
            message: `${named} matches several commits in ${where}: give more characters`,
          };
        if (ans.error === 'not_found' && named)
          return { code: 'commit_unknown', status: 422, message: `commit ${named} is not in ${where}` };
        return unresolved(`${what} could not be read: ${ans.message}`);
    }
  };
  const done = (
    ans: Extract<ProbeAnswer, { kind: 'commit' }>,
    source: DeployCommitSource,
    sourceDetail: string | null,
  ): ResolvedDeployCommit => ({
    sha: ans.sha,
    shortSha: ans.shortSha,
    subject: ans.subject,
    author: ans.author,
    committedAt: ans.committedAt,
    source,
    sourceDetail,
    branch,
  });

  if (a.explicit) {
    const ans = await probe(a.explicit);
    return ans.kind === 'commit'
      ? done(ans, 'explicit', null)
      : fail(ans, `commit ${a.explicit}`, a.explicit);
  }
  if (a.live) {
    const rel = await newestShippedRelease(ctx.pool, repo.id);
    if (rel) {
      const ans = await probe(rel.commit);
      return ans.kind === 'commit'
        ? done(ans, 'release', `release ${rel.version}`)
        : fail(ans, `the release commit of ${rel.version}`, null);
    }
  }
  const promoted = await promotedCommit(ctx.pool, a.projectId, a.gates);
  if (promoted) {
    const ans = await probe(promoted.commit);
    return ans.kind === 'commit'
      ? done(ans, 'promoted', `what ${promoted.fromEnv} runs`)
      : fail(ans, `the commit ${promoted.fromEnv} runs`, null);
  }
  if (!branch) return unresolved(`${where} names no working branch, so there is no tip to deploy`);
  const ans = await probe(null);
  return ans.kind === 'commit'
    ? done(ans, 'working-branch', `tip of ${branch}`)
    : fail(ans, `the tip of ${branch}`, null);
}

const samePrefix = (a: string, b: string) => a === b || a.startsWith(b) || b.startsWith(a);

/**
 * May an automated requester (the CEO, DevOps, a trigger) deploy this explicit commit? Only a commit the project really
 * merged: the latest merge, any `CardFinalized` merge commit of the project, or the commit an `envHealthy` requirement of
 * the gate points at. Any other hex string (a commit that was never merged here) is refused. Humans choose freely.
 */
export async function automatedCommitAllowed(
  db: Queryable,
  projectId: string,
  commit: string,
  gates: Array<{ gate: Gate }>,
  repoId: string | null = null,
): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/.test(commit)) return false;
  const latest = await latestMerge(db, projectId, repoId);
  if (latest && samePrefix(latest.commit, commit)) return true;
  if (
    await one(
      db,
      `SELECT 1 FROM events e WHERE e.project_id=$1 AND e.type='CardFinalized'
          AND e.payload->'resultRef'->>'mergeCommit' IS NOT NULL
          AND (e.payload->'resultRef'->>'mergeCommit' = $3 OR starts_with(e.payload->'resultRef'->>'mergeCommit', $3)
               OR starts_with($3, e.payload->'resultRef'->>'mergeCommit'))
          AND ($2::uuid IS NULL OR ${MERGE_IN_REPO})
        LIMIT 1`,
      [projectId, repoId, commit],
    )
  )
    return true;
  for (const g of gates)
    for (const r of g.gate.requires)
      if ('envHealthy' in r) {
        const prev = await one(
          db,
          `SELECT COALESCE(deployed_commit, commit) AS commit FROM deploy_runs
            WHERE project_id=$1 AND env=$2 AND status='succeeded' AND NOT trial AND NOT dry_run
            ORDER BY finished_at DESC LIMIT 1`,
          [projectId, r.envHealthy],
        );
        if (prev?.commit && samePrefix(prev.commit, commit)) return true;
      }
  return false;
}

/** Who may release this run now. The CEO is the releaser only when the recipe says so. */
export function releaseDecision(
  env: Pick<RecipeEnv, 'releasedBy'>,
  requester: DeployRequester,
  production: boolean,
): { release: true; by: DeployActor } | { release: false; waitingFor: 'owner' | 'ceo' } {
  const by = actorOnly(requester);
  if (requester.kind === 'owner' || requester.kind === 'admin') return { release: true, by };
  if (env.releasedBy === 'auto' && requester.kind !== 'ceo')
    return { release: true, by: { ...by, kind: requester.kind === 'trigger' ? 'trigger' : requester.kind } };
  if (env.releasedBy === 'auto') {
    // `auto` is a rule, not a licence for the CEO: a CEO woken by outside text never releases production through it.
    if (production && requester.untrusted) return { release: false, waitingFor: 'owner' };
    return { release: true, by: { kind: 'trigger', id: null, name: 'automatic' } };
  }
  if (env.releasedBy === 'ceo') {
    // An untrusted wake (outside text may have caused it) never releases production, even where the recipe names the CEO.
    if (requester.kind === 'ceo' && !(production && requester.untrusted)) return { release: true, by };
    return { release: false, waitingFor: requester.kind === 'ceo' ? 'owner' : 'ceo' };
  }
  return { release: false, waitingFor: 'owner' };
}

const refusedEvent = (
  p: { orgId: string; projectId: string; runId: string; env: string },
  reason: string,
  detail: string,
  missing: string[],
  req: {
    recipeId: string | null;
    targetId: string | null;
    targetName: string;
    hash: string;
    commit: string | null;
    trigger: string;
    requester: DeployRequester;
    trial: boolean;
    releasedBy: 'owner' | 'ceo' | 'auto';
    phaseFollowupId?: string | undefined;
    commitSource?: DeployRunCommitSource;
    commitSourceDetail?: string;
  },
): AppendInput => ({
  streamId: streamId.project(p.projectId),
  event: {
    type: 'DeployRunRefused',
    payload: {
      runId: p.runId,
      orgId: p.orgId,
      projectId: p.projectId,
      env: p.env,
      reason,
      detail: detail.slice(0, 500),
      missing: missing.slice(0, 30),
      request: {
        recipeId: req.recipeId,
        targetId: req.targetId,
        targetName: req.targetName,
        hash: req.hash,
        commit: req.commit,
        trigger: req.trigger,
        requestedBy: actorOnly(req.requester),
        origin: originOf(req.requester),
        trial: req.trial,
        releasedBy: req.releasedBy,
        ...(req.phaseFollowupId ? { phaseFollowupId: req.phaseFollowupId } : {}),
        ...(req.commitSource ? { commitSource: req.commitSource } : {}),
        ...(req.commitSourceDetail ? { commitSourceDetail: req.commitSourceDetail.slice(0, 200) } : {}),
      },
    },
  },
  actor: actorEvent(req.requester),
  scope: projectScope(p.orgId, p.projectId),
});

/** The refusal of a whole request (before any target is looked at): one audited row. */
async function refuseAll(
  ctx: Ctx,
  project: Row,
  input: RequestDeployInput,
  reason: string,
  detail: string,
  extra: { recipeId?: string | null; hash?: string } = {},
): Promise<RequestDeployResult> {
  const runId = randomUUID();
  await ctx.store.append([
    refusedEvent(
      { orgId: project.org_id, projectId: project.id, runId, env: input.env },
      reason,
      detail,
      [],
      {
        recipeId: extra.recipeId ?? null,
        targetId: null,
        targetName: '',
        hash: extra.hash ?? '',
        commit: input.commit ?? null,
        trigger: input.trigger,
        requester: input.requester,
        trial: input.trial === true,
        releasedBy: 'owner',
        phaseFollowupId: input.phaseFollowupId,
      },
    ),
  ]);
  return {
    runs: [{ runId, target: '', status: 'refused', refusal: reason, detail }],
    message: `Refused (${reason}): ${detail}`,
  };
}

/** Requests for one project and environment run one after the other, so a double click cannot start two runs. */
const requestChains = new Map<string, Promise<unknown>>();

export async function requestDeployRun(ctx: Ctx, input: RequestDeployInput): Promise<RequestDeployResult> {
  const key = `${input.projectId}|${input.env}`;
  const before = requestChains.get(key) ?? Promise.resolve();
  // The chain serialises requests inside this process (and keeps one lock-waiting connection per key); the database lock
  // is the guarantee across processes. It is held until the run's events are committed, so the next request sees them.
  const mine = before
    .catch(() => undefined)
    .then(() =>
      withTx(ctx.pool, async (lockTx) => {
        await lockTx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deploy_request:${key}`]);
        return requestDeployRunNow(ctx, input);
      }),
    );
  const tail = mine.catch(() => undefined);
  requestChains.set(key, tail);
  try {
    return await mine;
  } finally {
    if (requestChains.get(key) === tail) requestChains.delete(key);
  }
}

async function requestDeployRunNow(ctx: Ctx, input: RequestDeployInput): Promise<RequestDeployResult> {
  const now = ctx.clock.now();
  const project = await one(
    ctx.pool,
    `SELECT id, org_id, key, delivery_mode, working_branch FROM projects WHERE id=$1 AND kind='project'`,
    [input.projectId],
  );
  if (!project) throw notFound('project not found');
  const trial = input.trial === true;
  const recipeRow = await loadRecipeRow(ctx.pool, project.id);
  if (!trial && project.delivery_mode !== 'recipe')
    return refuseAll(
      ctx,
      project,
      input,
      'not_recipe_mode',
      (await releasesPaused(ctx.pool, project.id))
        ? 'Releases are paused for this project. Turn them back on in Environments, then try again.'
        : 'Guided deploys are not turned on for this project yet. Open Environments and turn them on, then press Release again.',
      {
        recipeId: recipeRow?.id ?? null,
      },
    );
  if (!recipeRow?.present)
    return refuseAll(ctx, project, input, 'no_recipe', 'this project has no delivery recipe in its vault');
  // The approved recipe and nothing else runs; a recipe that changed since the Owner approved it refuses (section 9.4).
  let recipe: Recipe | null;
  let hash: string;
  let vaultCommit: string | null;
  let dryRun = false;
  if (trial) {
    if (recipeRow.status === 'approved') {
      recipe = (recipeRow.approved_parsed ?? recipeRow.parsed) as Recipe | null;
      hash = recipeRow.approved_hash;
      vaultCommit = recipeRow.approved_commit ?? null;
      dryRun = true;
    } else if (recipeRow.status === 'observed' || recipeRow.status === 'changed_unapproved') {
      recipe = recipeRow.parsed as Recipe | null;
      hash = recipeRow.observed_hash;
      vaultCommit = recipeRow.observed_commit ?? null;
    } else
      return refuseAll(ctx, project, input, 'recipe_not_trialable', `the recipe is ${recipeRow.status}`, {
        recipeId: recipeRow.id,
        hash: recipeRow.observed_hash ?? '',
      });
  } else {
    if (!recipeRow.approved_hash)
      return refuseAll(
        ctx,
        project,
        input,
        'recipe_not_approved',
        'the Owner has not approved this recipe yet',
        {
          recipeId: recipeRow.id,
          hash: recipeRow.observed_hash ?? '',
        },
      );
    if (recipeRow.status !== 'approved' || recipeRow.observed_hash !== recipeRow.approved_hash)
      return refuseAll(
        ctx,
        project,
        input,
        'recipe_changed',
        'the recipe changed since the Owner approved it: it needs a new approval',
        { recipeId: recipeRow.id, hash: recipeRow.observed_hash ?? '' },
      );
    recipe = (recipeRow.approved_parsed ?? recipeRow.parsed) as Recipe | null;
    hash = recipeRow.approved_hash;
    vaultCommit = recipeRow.approved_commit ?? null;
  }
  const env = recipe?.environments.find((e) => e.name === input.env);
  if (!recipe || !env)
    return refuseAll(
      ctx,
      project,
      input,
      'unknown_env',
      `the recipe has no environment ${input.env} (it has ${recipe?.environments.map((e) => e.name).join(', ') ?? 'none'})`,
      { recipeId: recipeRow.id, hash },
    );
  if (input.trigger !== 'request' && !env.triggers.includes(input.trigger as Trigger))
    return refuseAll(
      ctx,
      project,
      input,
      'trigger_not_allowed',
      `${env.name} is not triggered by ${input.trigger}`,
      {
        recipeId: recipeRow.id,
        hash,
      },
    );
  const vault = await projectVault(ctx.pool, project.id);
  if (!vault)
    return refuseAll(ctx, project, input, 'no_vault', NO_PROJECT_VAULT, { recipeId: recipeRow.id, hash });
  // an environment that is being moved to a new server is not deployed meanwhile (the move copies a version, then switches)
  const moving = await one(
    ctx.pool,
    `SELECT 1 AS x FROM deploy_target_moves WHERE project_id=$1 AND env_name=$2 AND state = ANY($3::text[])`,
    [project.id, env.name, [...MOVE_OPEN_STATES]],
  );
  if (moving)
    return refuseAll(
      ctx,
      project,
      input,
      'move_in_progress',
      `${env.name} is being moved to a new server: deploys wait until the move is finished or given up`,
      { recipeId: recipeRow.id, hash },
    );

  const targetRows = await rows(
    ctx.pool,
    `SELECT * FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL AND role = 'active' AND lower(name) = ANY($2::text[])`,
    [project.id, env.targets.map((t) => t.toLowerCase())],
  );
  const wanted = input.targets?.map((t) => t.toLowerCase());
  const chosen = env.targets
    .map((name) => targetRows.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? { missing: name })
    .filter((t) => !wanted || wanted.includes(('missing' in t ? t.missing : t.name).toLowerCase()));
  if (wanted && chosen.length === 0)
    return refuseAll(
      ctx,
      project,
      input,
      'target_not_in_recipe',
      `${env.name} does not deploy to ${input.targets?.join(', ')}`,
      {
        recipeId: recipeRow.id,
        hash,
      },
    );

  const repoRow = await envRepo(ctx.pool, project.id, env.repo);
  const live =
    (await environmentRoles(ctx.pool, project.id)).find((r) => r.name === env.name)?.role === 'live';
  const probes = new Map<string, Promise<ProbeAnswer>>();

  const outcomes: DeployRunOutcome[] = [];
  const commands: Array<{ ws: string; payload: DeployExecPayload }> = [];
  let wakeCeo: { runId: string; target: string } | null = null;
  let notice: { runId: string; target: string } | null = null;
  const events: AppendInput[] = [];
  let dryRuns = false;
  for (const t of chosen) {
    const runId = randomUUID();
    const targetName = 'missing' in t ? t.missing : t.name;
    const production = !('missing' in t) && !!t.production;
    const base = {
      recipeId: recipeRow.id as string,
      targetId: 'missing' in t ? null : (t.id as string),
      targetName,
      hash,
      trigger: input.rollback ? 'rollback' : input.trigger,
      requester: input.requester,
      trial,
      releasedBy: env.releasedBy,
      phaseFollowupId: input.phaseFollowupId,
    };
    let source: DeployRunCommitSource | null = null;
    let sourceDetail: string | null = null;
    let resolvedBranch: string | null = null;
    const refuse = (
      reason: string,
      detail: string,
      missing: string[] = [],
      commit: string | null = input.commit ?? null,
    ) => {
      events.push(
        refusedEvent(
          { orgId: project.org_id, projectId: project.id, runId, env: env.name },
          reason,
          detail,
          missing,
          {
            ...base,
            commit,
            ...(source ? { commitSource: source } : {}),
            ...(sourceDetail ? { commitSourceDetail: sourceDetail } : {}),
          },
        ),
      );
      outcomes.push({ runId, target: targetName, status: 'refused', refusal: reason, detail, missing });
    };
    if ('missing' in t) {
      refuse('unknown_target', `the deploy target ${targetName} does not exist in ${project.key}`);
      continue;
    }
    // Trials of an unapproved recipe never touch production: only a dry run (AOM_DEPLOY_DRY_RUN=1) may.
    const runDry = dryRun || (trial && (production || input.dryRun === true));
    if (runDry) dryRuns = true;
    // Where the deploy runs comes first: the commit is read there (the workstation holds the clone).
    const ws = await deployWorkstation(ctx.pool, project, vault, t);
    if ('error' in ws) {
      refuse(ws.reason ?? 'no_workstation', ws.error, []);
      continue;
    }
    if (await lacksCapability(ctx.pool, ws.id)) {
      refuse('runner_outdated', 'the workstation runner does not support recipe deploys yet: update it', []);
      continue;
    }
    const wsName = (
      await one<{ name: string }>(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [ws.id])
    )?.name;
    // The commit may come from the gate itself (promote what the earlier environment runs), so the gates are read first.
    let commit: string | null;
    let finalVerdict: EnvGateVerdict | null = null;
    const automated = input.requester.kind !== 'owner' && input.requester.kind !== 'admin';
    const gateInput = {
      orgId: project.org_id as string,
      projectId: project.id as string,
      env,
      production,
      now,
      repoId: (repoRow?.id as string | undefined) ?? null,
    };
    const gates = trial ? [] : (await effectiveGates(ctx.pool, gateInput)).gates;
    // One resolution for every way a commit is chosen; a commit the server itself vouches for is trusted as it is.
    const trusted = !!input.rollback || !!input.commitSource || (!!input.commit && !!input.pinnedCommit);
    const resolveHere = async (explicit: string | null): Promise<ResolvedDeployCommit | null> => {
      const r = await resolveDeployCommit(ctx, {
        projectId: project.id,
        projectBranch: project.working_branch ?? null,
        envName: env.name,
        live,
        repo: repoRow,
        gates,
        explicit,
        workstationId: ws.id,
        workstationName: wsName,
        probes,
      });
      if ('code' in r) {
        // A commit a person named that does not exist: nothing is recorded, no run exists.
        if (r.status === 422) throw unprocessable(r.code, r.message);
        refuse(r.code, r.message, [], input.commit ?? null);
        return null;
      }
      if (!explicit && input.expectCommit && !samePrefix(r.sha, input.expectCommit))
        throw new HttpError(
          409,
          'commit_moved',
          `the commit to deploy is now ${r.shortSha}, not ${input.expectCommit.slice(0, 10)}: look at it again and confirm`,
          { expected: input.expectCommit, resolved: r.sha },
        );
      return r;
    };
    if (trial) {
      if (
        automated &&
        input.commit &&
        !input.pinnedCommit &&
        !(await automatedCommitAllowed(ctx.pool, project.id, input.commit, [], repoRow?.id ?? null))
      ) {
        refuse('commit_not_allowed', COMMIT_NOT_ALLOWED);
        continue;
      }
    } else if (input.rollback) {
      if (gates.some((g) => g.gate.freeze)) {
        refuse(
          'frozen',
          'releases are frozen: nothing goes out, not even an earlier version',
          ['releases are frozen'],
          input.rollback.commit,
        );
        continue;
      }
    } else if (
      automated &&
      input.commit &&
      !input.pinnedCommit &&
      !input.commitSource &&
      !(await automatedCommitAllowed(ctx.pool, project.id, input.commit, gates, repoRow?.id ?? null))
    ) {
      refuse('commit_not_allowed', COMMIT_NOT_ALLOWED);
      continue;
    }
    if (input.rollback) {
      commit = input.rollback.commit;
      source = 'rollback';
      finalVerdict = {
        satisfied: true,
        missing: [],
        evidence: [
          {
            requirement: 'rollback',
            ref: input.rollback.runId,
            detail: `going back to ${commit.slice(0, 10)}, an earlier release of ${env.name}`,
          },
        ],
        gates,
      };
    } else if (trusted || (automated && input.commit)) {
      commit = input.commit ?? null;
      source = input.commitSource ?? 'explicit';
      sourceDetail = input.commitSourceDetail ?? null;
    } else {
      const r = await resolveHere(input.commit ?? null);
      if (!r) continue;
      commit = r.sha;
      source = r.source;
      sourceDetail = r.sourceDetail;
      resolvedBranch = r.branch;
    }
    if (!trial && !input.rollback) finalVerdict = await evaluateEnvGate(ctx.pool, { ...gateInput, commit });
    if (finalVerdict && !finalVerdict.satisfied) {
      refuse(
        'gate_unsatisfied',
        `the gate for ${env.name} does not hold yet: ${finalVerdict.missing.join('; ')}`,
        finalVerdict.missing,
        commit,
      );
      continue;
    }

    // R30: a target that takes only a signed runner deploys a shipped release whose runner carries a signature by its key.
    let signing: DeployExecPayload['signing'];
    if (!runDry) {
      const g = await signingGate(ctx.pool, project.id, t, commit);
      if (g.required && 'refusal' in g) {
        refuse(RUNNER_SIGNATURE_REQUIRED, g.refusal, [`a signed runner for ${targetName}`], commit);
        continue;
      }
      if (g.required) signing = g.signing;
    }

    // An open run of this environment and target: a waiting one with the same recipe and commit is the one to release;
    // another waiting one is replaced by this newer request; a running one is never touched.
    const open = await one(
      ctx.pool,
      `SELECT id, status, hash, commit FROM deploy_runs WHERE project_id=$1 AND env=$2 AND target_name=$3
          AND status IN ('requested','waiting_release','queued','running') AND NOT trial`,
      [project.id, env.name, targetName],
    );
    if (!trial && open && (open.status === 'running' || open.status === 'queued')) {
      refuse('run_in_progress', `${env.name} on ${targetName} is being deployed right now`, [], commit);
      continue;
    }
    const decision = trial
      ? ({ release: true, by: actorOnly(input.requester) } as const)
      : releaseDecision(env, input.requester, production);
    const reuse =
      !trial && open?.status === 'waiting_release' && open.hash === hash && (open.commit ?? null) === commit;
    if (!trial && open && !reuse)
      events.push({
        streamId: streamId.project(project.id),
        event: {
          type: 'DeployRunCancelled',
          payload: { runId: open.id, orgId: project.org_id, projectId: project.id, by: null },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(project.org_id, project.id),
      });
    const id = reuse ? (open?.id as string) : runId;
    if (!reuse)
      events.push({
        streamId: streamId.project(project.id),
        event: {
          type: 'DeployRunRequested',
          payload: {
            runId: id,
            orgId: project.org_id,
            projectId: project.id,
            recipeId: recipeRow.id,
            env: env.name,
            targetId: t.id,
            targetName,
            workstationId: ws.id,
            hash,
            vaultCommit,
            commit,
            trigger: input.rollback ? 'rollback' : input.trigger,
            requestedBy: actorOnly(input.requester),
            origin: originOf(input.requester),
            trial,
            dryRun: runDry,
            releasedBy: env.releasedBy,
            ...(input.phaseFollowupId ? { phaseFollowupId: input.phaseFollowupId } : {}),
            ...(source ? { commitSource: source } : {}),
            ...(sourceDetail ? { commitSourceDetail: (sourceDetail as string).slice(0, 200) } : {}),
          },
        },
        actor: actorEvent(input.requester),
        scope: projectScope(project.org_id, project.id),
      });
    if (decision.release) {
      events.push({
        streamId: streamId.project(project.id),
        event: {
          type: 'DeployGateSatisfied',
          payload: {
            runId: id,
            orgId: project.org_id,
            projectId: project.id,
            env: env.name,
            gate: finalVerdict?.gates.map((g) => ({ label: g.label, ...g.gate })) ?? [],
            evidence: (finalVerdict?.evidence ?? []) as GateEvidence[],
            releasedBy: decision.by,
            recipeHash: hash,
          },
        },
        actor: actorEvent(decision.by),
        scope: projectScope(project.org_id, project.id),
      });
      commands.push({
        ws: ws.id,
        payload: {
          runId: id,
          orgId: project.org_id,
          projectId: project.id,
          projectKey: project.key,
          vault: { vaultId: vault.vaultId, storage: vault.storage, folder: vault.folder },
          vaultCommit,
          hash,
          env: env.name,
          target: {
            id: t.id,
            name: t.name,
            kind: t.kind,
            host: t.host ?? null,
            appUrl: t.app_url ?? null,
          },
          commit,
          repo: repoRow
            ? {
                repoId: repoRow.id,
                name: repoRow.name,
                remoteUrlNormalized: repoRow.remote_url_normalized,
                workingBranch: repoRow.working_branch ?? resolvedBranch ?? null,
              }
            : null,
          trial,
          dryRun: runDry,
          expiresAt: new Date(now.getTime() + DEPLOY_EXEC_TTL_MS).toISOString(),
          ...(signing ? { signing } : {}),
        },
      });
      outcomes.push({ runId: id, target: targetName, status: 'queued' });
    } else {
      if (!reuse)
        events.push({
          streamId: streamId.project(project.id),
          event: {
            type: 'DeployRunQueued',
            payload: {
              runId: id,
              orgId: project.org_id,
              projectId: project.id,
              env: env.name,
              waitingFor: decision.waitingFor,
            },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(project.org_id, project.id),
        });
      outcomes.push({
        runId: id,
        target: targetName,
        status: 'waiting_release',
        waitingFor: decision.waitingFor,
      });
      if (!reuse) {
        if (decision.waitingFor === 'ceo') wakeCeo = { runId: id, target: targetName };
        notice = { runId: id, target: targetName };
      }
    }
  }
  if (events.length > 0)
    await withAppendTx(ctx.pool, async (tx) => {
      await ctx.store.append(events, { tx });
      for (const c of commands)
        await enqueueRunnerCommand(
          tx,
          c.ws,
          'deploy.exec',
          c.payload as unknown as Record<string, unknown>,
          new Date(c.payload.expiresAt),
        );
    });
  for (const ws of new Set(commands.map((c) => c.ws)))
    void Promise.resolve(ctx.services.gateway.deliverPending(ws)).catch(() => undefined);
  const waiting = outcomes.filter((o) => o.status === 'waiting_release');
  if (waiting.length > 0) {
    const first = waiting[0] as DeployRunOutcome;
    const waitingFor = first.waitingFor ?? 'owner';
    const noticeSubject = `deploy_release:${project.id}:${env.name}`;
    if (notice && waitingFor === 'owner')
      await raiseDeskNotice(ctx, {
        orgId: project.org_id,
        projectId: project.id,
        subkind: DEPLOY_RELEASE_SUBKIND,
        subjectKey: noticeSubject,
        title: `${project.key}: ${env.name} is ready to release`,
        body: `${waiting.map((w) => w.target).join(', ')} can be released. Open Deploys and press Release${waiting.length > 1 ? ' for the servers you want' : ''}. The gate holds and the recipe is approved; nothing runs until someone releases it.`,
        data: { projectId: project.id, env: env.name, runIds: waiting.map((w) => w.runId) },
        pinned: true,
      });
    if (wakeCeo)
      await enqueueWake(
        ctx.pool,
        project.org_id,
        {
          reason: 'deploy_ready',
          urgency: 'normal',
          subjectKind: 'deploy_run',
          subjectId: wakeCeo.runId,
          subjectLabel: `${project.key} ${env.name} is ready to release (the recipe names you as the releaser)`,
          detail: { projectKey: project.key, env: env.name, runId: wakeCeo.runId },
        },
        now,
      ).catch(() => undefined);
  }
  // R30: a person whose deploy is refused only for want of a runner signature gets the 409 (the refusals are recorded).
  if (
    (input.requester.kind === 'owner' || input.requester.kind === 'admin') &&
    outcomes.length > 0 &&
    outcomes.every((o) => o.status === 'refused' && o.refusal === RUNNER_SIGNATURE_REQUIRED)
  )
    throw new HttpError(409, RUNNER_SIGNATURE_REQUIRED, outcomes.map((o) => o.detail).join(' '), {
      runs: outcomes,
    });
  const queued = outcomes.filter((o) => o.status === 'queued');
  const refused = outcomes.filter((o) => o.status === 'refused');
  const parts: string[] = [];
  if (queued.length)
    parts.push(
      `${env.name} on ${queued.map((q) => q.target).join(', ')} was released${trial ? ' as a trial' : ''}${dryRuns ? ' (dry run)' : ''}: the workstation runs the recipe, outside any model.`,
    );
  if (waiting.length) {
    const who = waiting[0]?.waitingFor === 'ceo' ? 'the CEO' : 'the Owner or an Admin';
    parts.push(
      `${env.name} on ${waiting.map((q) => q.target).join(', ')} is ready and waits in the release queue for ${who} to press Release.`,
    );
  }
  for (const r of refused)
    parts.push(`${r.target ? `${r.target}: ` : ''}refused (${r.refusal}): ${r.detail}`);
  return { runs: outcomes, message: parts.join(' ') };
}

/**
 * `GET .../delivery/deploy/preview`: the commit a deploy of `env` would build now. The same `resolveDeployCommit` as the
 * deploy; creates no run, appends no event and queues no command.
 */
export async function previewDeployCommit(
  ctx: Ctx,
  projectId: string,
  q: DeployCommitPreviewQuery,
): Promise<DeployCommitPreview> {
  const project = await one(
    ctx.pool,
    `SELECT id, org_id, key, working_branch FROM projects WHERE id=$1 AND kind='project'`,
    [projectId],
  );
  if (!project) throw notFound('project not found');
  const recipeRow = await loadRecipeRow(ctx.pool, project.id);
  const recipe = (recipeRow?.approved_parsed ?? recipeRow?.parsed ?? null) as Recipe | null;
  const env = recipe?.environments.find((e) => e.name === q.env);
  if (!recipeRow?.present || !env)
    throw new HttpError(404, 'unknown_env', `the recipe has no environment ${q.env}`);
  const vault = await projectVault(ctx.pool, project.id);
  if (!vault) throw new HttpError(409, 'no_vault', NO_PROJECT_VAULT);
  const targetRows = await rows(
    ctx.pool,
    `SELECT * FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL AND role = 'active' AND lower(name) = ANY($2::text[])
      ORDER BY name, id`,
    [project.id, env.targets.map((t) => t.toLowerCase())],
  );
  const target = q.target
    ? targetRows.find((t) => t.name.toLowerCase() === q.target?.toLowerCase())
    : env.targets
        .map((name) => targetRows.find((t) => t.name.toLowerCase() === name.toLowerCase()))
        .find((t) => !!t);
  if (!target) throw new HttpError(404, 'unknown_target', `${q.env} has no such deploy target`);
  const ws = await deployWorkstation(ctx.pool, project, vault, target);
  if ('error' in ws) throw new HttpError(409, ws.reason ?? 'no_workstation', ws.error);
  const repo = await envRepo(ctx.pool, project.id, env.repo);
  const gates = (
    await effectiveGates(ctx.pool, {
      orgId: project.org_id,
      projectId: project.id,
      env,
      production: !!target.production,
      repoId: repo?.id ?? null,
    })
  ).gates;
  const live =
    (await environmentRoles(ctx.pool, project.id)).find((r) => r.name === env.name)?.role === 'live';
  const wsName = (await one<{ name: string }>(ctx.pool, 'SELECT name FROM workstations WHERE id=$1', [ws.id]))
    ?.name;
  const r = await resolveDeployCommit(ctx, {
    projectId: project.id,
    projectBranch: project.working_branch ?? null,
    envName: env.name,
    live,
    repo,
    gates,
    explicit: q.commit ?? null,
    workstationId: ws.id,
    workstationName: wsName,
  });
  if ('code' in r) throw new HttpError(r.status, r.code, r.message);
  return {
    env: env.name,
    repo: repo?.name ?? null,
    branch: r.branch,
    sha: r.sha,
    shortSha: r.shortSha,
    subject: r.subject,
    author: r.author,
    committedAt: r.committedAt,
    source: r.source,
    sourceDetail: r.sourceDetail,
  };
}

// ------------------------------------------------------------------------------------------------ the release queue

export async function listDeployRuns(
  db: Queryable,
  filter: { orgId: string; projectId?: string; status?: string[]; limit?: number },
): Promise<Row[]> {
  return rows(
    db,
    `SELECT r.*, p.key AS project_key, p.name AS project_name FROM deploy_runs r JOIN projects p ON p.id = r.project_id
      WHERE r.org_id=$1 AND ($2::uuid IS NULL OR r.project_id=$2) AND ($3::text[] IS NULL OR r.status = ANY($3))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $4`,
    [filter.orgId, filter.projectId ?? null, filter.status ?? null, filter.limit ?? 100],
  );
}

async function managerOf(ctx: Ctx, user: AuthSession['user'], orgId: string): Promise<'owner' | 'admin'> {
  const role = await orgRoleOf(ctx.pool, user.id, orgId);
  if (role !== 'owner' && role !== 'admin') throw forbidden('only an Owner or an Admin releases a deploy');
  return role;
}

/**
 * The Owner or an Admin presses Release on the runs they chose (one per server). Each is checked again right now: the recipe
 * must still be approved at the hash the run was requested with, and the gate must still hold.
 */
export async function releaseFromQueue(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  runIds: string[],
): Promise<RequestDeployResult> {
  const role = await managerOf(ctx, user, orgId);
  const outcomes: DeployRunOutcome[] = [];
  const msgs: string[] = [];
  for (const runId of runIds) {
    const run = await one(ctx.pool, 'SELECT * FROM deploy_runs WHERE id=$1 AND org_id=$2', [runId, orgId]);
    if (!run) throw notFound('release not found');
    if (run.status !== 'waiting_release') {
      outcomes.push({
        runId,
        target: run.target_name,
        status: 'refused',
        refusal: 'not_waiting',
        detail: `it is ${run.status}`,
      });
      continue;
    }
    const r = await requestDeployRun(ctx, {
      projectId: run.project_id,
      env: run.env,
      commit: run.commit,
      // the commit was resolved (and checked) when the run was requested: it is released as it is, with its source
      commitSource: run.commit_source ?? 'explicit',
      ...(run.commit_source_detail ? { commitSourceDetail: run.commit_source_detail } : {}),
      targets: [run.target_name],
      trigger: 'request',
      requester: { kind: role, id: user.id, name: user.displayName, provenance: 'session' },
      ...(run.phase_followup_id ? { phaseFollowupId: run.phase_followup_id } : {}),
    });
    outcomes.push(...r.runs);
    msgs.push(r.message);
  }
  if (runIds.length > 0) {
    // The ready-notice closes once nothing of that environment waits any more.
    const first = await one(ctx.pool, 'SELECT project_id, env FROM deploy_runs WHERE id=$1', [runIds[0]]);
    if (first) {
      const left = await one(
        ctx.pool,
        `SELECT 1 FROM deploy_runs WHERE project_id=$1 AND env=$2 AND status='waiting_release'`,
        [first.project_id, first.env],
      );
      if (!left) await closeDeskNotice(ctx, `deploy_release:${first.project_id}:${first.env}`, user.id);
    }
  }
  return { runs: outcomes, message: msgs.join(' ') };
}

export async function cancelRun(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string,
  runId: string,
): Promise<void> {
  await managerOf(ctx, user, orgId);
  const run = await one(ctx.pool, 'SELECT * FROM deploy_runs WHERE id=$1 AND org_id=$2', [runId, orgId]);
  if (!run) throw notFound('release not found');
  if (run.status !== 'waiting_release') return;
  await ctx.store.append([
    {
      streamId: streamId.project(run.project_id),
      event: {
        type: 'DeployRunCancelled',
        payload: { runId, orgId, projectId: run.project_id, by: user.id },
      },
      actor: userActor(user.id),
      scope: projectScope(orgId, run.project_id),
    },
  ]);
  const left = await one(
    ctx.pool,
    `SELECT 1 FROM deploy_runs WHERE project_id=$1 AND env=$2 AND status='waiting_release'`,
    [run.project_id, run.env],
  );
  if (!left) await closeDeskNotice(ctx, `deploy_release:${run.project_id}:${run.env}`, user.id);
}

// ------------------------------------------------------------------------------------------------ what the workstation says

/** `deploy.progress` from the workstation: the run started. */
export async function applyDeployProgress(
  ctx: Ctx,
  workstationId: string,
  msg: { runId: string; phase: string },
): Promise<void> {
  if (msg.phase !== 'started') return;
  const run = await one(
    ctx.pool,
    `SELECT id, org_id, project_id FROM deploy_runs WHERE id=$1 AND status='queued' AND workstation_id=$2`,
    [msg.runId, workstationId],
  );
  if (!run) return;
  await ctx.store.append([
    {
      streamId: streamId.project(run.project_id),
      event: {
        type: 'DeployRunStarted',
        payload: { runId: run.id, orgId: run.org_id, projectId: run.project_id, workstationId },
      },
      actor: runnerActor(workstationId),
      scope: projectScope(run.org_id, run.project_id),
    },
  ]);
}

/** `command.result` of `deploy.exec`: a refusal or a failed deploy is an answer; the run's final state and the audit follow. */
export async function applyDeployResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const runId = String(payload.runId ?? '');
  const run = await one(ctx.pool, `SELECT * FROM deploy_runs WHERE id=$1`, [runId]);
  if (!run || !['queued', 'running'].includes(run.status)) return;
  const parsed = ok ? DeployExecResultSchema.safeParse(result) : null;
  const r = parsed?.success
    ? parsed.data
    : {
        outcome: 'failed' as const,
        summary: error ?? 'the workstation did not answer in a form the server understands',
        logTail: '',
        durationMs: 0,
      };
  const outcome = r.outcome;
  const summary =
    r.refused && outcome === 'refused'
      ? `refused: ${r.refused}`
      : (r.summary || (outcome === 'succeeded' ? 'deployed' : 'the deploy failed')).slice(0, 500);
  await ctx.store.append([
    {
      streamId: streamId.project(run.project_id),
      event: {
        type: 'DeployRunFinished',
        payload: {
          runId,
          orgId: run.org_id,
          projectId: run.project_id,
          env: run.env,
          outcome,
          health: 'health' in r ? (r.health ?? null) : null,
          smoke: 'smoke' in r ? (r.smoke ?? null) : null,
          ...('deployed' in r && r.deployed?.url ? { url: r.deployed.url } : {}),
          deployedCommit: ('deployedCommit' in r ? r.deployedCommit : null) ?? run.commit ?? null,
          summary,
          // The tail is output of the customer's own script: it is stored masked (secrets, paths, e-mail addresses).
          logTail: maskText(r.logTail ?? '').slice(0, 6000),
          exitCode: 'exitCode' in r ? (r.exitCode ?? null) : null,
        },
      },
      actor: runnerActor(workstationId),
      scope: projectScope(run.org_id, run.project_id),
    },
  ]);
  // A deploy that did not get through may mean the server cannot be reached any more: look, so the card says so.
  if (outcome !== 'succeeded' && run.target_name)
    await one(
      ctx.pool,
      `SELECT id FROM deploy_targets WHERE project_id=$1 AND lower(name)=lower($2) AND kind='remote_ssh' AND removed_at IS NULL`,
      [run.project_id, run.target_name],
    )
      .then((t) => (t ? queueReachabilityCheck(ctx, t.id) : false))
      .catch(() => false);
  const project = await one(ctx.pool, 'SELECT key FROM projects WHERE id=$1', [run.project_id]);
  // A refusal for a missing secret names it on the desk (section 9.6).
  if (outcome === 'refused' && r.refused?.startsWith('missing_secret:'))
    await raiseDeskNotice(ctx, {
      orgId: run.org_id,
      projectId: run.project_id,
      subkind: 'deploy_secret',
      subjectKey: `deploy_secret:${run.project_id}:${r.refused}`,
      title: `${project?.key}: ${run.env} needs the secret ${r.refused.slice('missing_secret:'.length)}`,
      body: `The deploy was refused because the workstation does not hold ${r.refused.slice('missing_secret:'.length)}. Set it in Project settings, Delivery (the value is encrypted in your browser for the runner and never reaches Guildwise).`,
    }).catch(() => undefined);
  if (!run.trial)
    await enqueueWake(
      ctx.pool,
      run.org_id,
      {
        reason: 'deploy_finished',
        urgency: outcome === 'succeeded' ? 'normal' : 'urgent',
        subjectKind: 'deploy_run',
        subjectId: runId,
        subjectLabel: `${project?.key} ${run.env} on ${run.target_name}: ${outcome}`,
        detail: { projectKey: project?.key, env: run.env, outcome, target: run.target_name },
      },
      ctx.clock.now(),
    ).catch(() => undefined);
  void Promise.resolve(ctx.services.dispatcher.trigger()).catch(() => undefined);
}

/**
 * Runs whose command nobody collected in time (the workstation stayed offline past `expiresAt`) end as refused ("expired"):
 * a deploy must not fire hours later, when the facts it was checked against are gone.
 */
export async function sweepExpiredDeploys(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const stale = await rows(
    ctx.pool,
    `SELECT r.id, r.org_id, r.project_id, r.env FROM deploy_runs r
      WHERE r.status='queued' AND r.updated_at < $1`,
    [new Date(now.getTime() - DEPLOY_EXEC_TTL_MS - 60_000)],
  );
  for (const r of stale) {
    await ctx.store.append([
      {
        streamId: streamId.project(r.project_id),
        event: {
          type: 'DeployRunRefused',
          payload: {
            runId: r.id,
            orgId: r.org_id,
            projectId: r.project_id,
            env: r.env,
            reason: 'expired',
            detail: 'the workstation did not collect the deploy in time',
            missing: [],
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(r.org_id, r.project_id),
      },
    ]);
    await exec(
      ctx.pool,
      `UPDATE runner_commands SET status='failed', payload='{}'::jsonb WHERE type='deploy.exec' AND status IN ('pending','sent') AND payload->>'runId'=$1`,
      [r.id],
    );
  }
  return stale.length;
}
