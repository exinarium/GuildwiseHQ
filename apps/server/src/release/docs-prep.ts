import { randomUUID } from 'node:crypto';
import {
  DEFAULT_GUIDE_PATH,
  enabledReleaseDocsPrepSteps,
  isOrgManager,
  isReleaseDocsPrepStep,
  isResearchStage,
  missingReleaseDocsPrepRequirement,
  nextReleaseDocsPrepAction,
  normalizeGuidePath,
  RELEASE_DOCS_PREP_CAPABILITY,
  RELEASE_DOCS_PREP_GUIDE_PATH_CAPABILITY,
  RELEASE_DOCS_PREP_WRITER_TASKS_CAPABILITY,
  type ReleaseDocsPrepAction,
  type ReleaseDocsPrepGateInput,
  type ReleaseDocsPrepGateView,
  type ReleaseDocsPrepOverviewItem,
  type ReleaseDocsPrepPayload,
  ReleaseDocsPrepResultSchema,
  type ReleaseDocsPrepRunDto,
  type ReleaseDocsPrepSettingsDto,
  type ReleaseDocsPrepState,
  ReleaseDocsPrepSummarySchema,
  type RunSnapshot,
  releaseDocsPrepGate,
  releaseDocsPrepLink,
  releaseDocsPrepStep,
  releaseDocsPrepSteps,
  stepPhaseIndex,
  stepPhases,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { loadCommitAs } from '../commands/commit-as.ts';
import { projectScope, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { storedStepOutput } from './docs-prep-changelog.ts';
import {
  PHASE_FAILURE_HOOKS,
  PHASE_INPUTS,
  REPORT_MAX_BYTES,
  SERVER_PHASES,
  type ServerPhaseOutcome,
} from './docs-prep-phases.ts';
import { configuredGuidePaths, DOCS_PREP_STEP_HOOKS, guidePathFor } from './docs-prep-steps.ts';
import { loadReleaseReadiness } from './docs-prep-auto.ts';
import { loadFacts, repoReleaseBranch, requestReleaseFacts } from './facts.ts';
import { loadComponentRules } from './rules.ts';

const NAME = 'Release prep (docs and videos)';
const SWEEP_MS = 12 * 3_600_000;

// ------------------------------------------------------------------------------------------------------------- roles

/** The project Owner, or an organization Owner or Admin (the `setCommitAs` rule). 404 for outsiders. */
async function requireManager(db: Queryable, user: AuthSession['user'], projectId: string): Promise<Row> {
  const p = await loadVisibleProject(db, user.id, projectId);
  if (!(await canManage(db, user.id, p)))
    throw forbidden('only the project Owner or an organization Owner or Admin can do this');
  return p;
}

async function canManage(db: Queryable, userId: string, p: Row): Promise<boolean> {
  if (p.my_role === 'owner') return true;
  return p.org_id ? isOrgManager({ orgRole: await orgRoleOf(db, userId, p.org_id) }) : false;
}

// ---------------------------------------------------------------------------------------------------------- settings

function settingsOf(p: Row): {
  enabled: boolean;
  steps: Record<string, boolean>;
  guidePaths: Record<string, string>;
  autoStart: boolean;
} {
  const s = (p.release_docs_prep ?? {}) as {
    enabled?: unknown;
    steps?: Record<string, unknown>;
    autoStart?: unknown;
  };
  const steps: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(s.steps ?? {})) if (typeof v === 'boolean') steps[k] = v;
  return {
    enabled: s.enabled === true,
    steps,
    guidePaths: configuredGuidePaths(p.release_docs_prep),
    autoStart: s.autoStart === true,
  };
}

async function liveRepos(db: Queryable, projectId: string): Promise<Array<{ id: string; name: string }>> {
  const r = await rows(
    db,
    'SELECT id, name FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name, id',
    [projectId],
  );
  return r.map((x) => ({ id: String(x.id), name: String(x.name) }));
}

export async function getReleaseDocsPrepSettings(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<ReleaseDocsPrepSettingsDto> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const s = settingsOf(p);
  return {
    enabled: s.enabled,
    // only registered steps are listed
    steps: releaseDocsPrepSteps().map((d) => ({
      id: d.id,
      label: d.label,
      description: d.description,
      enabled: s.steps[d.id] ?? d.defaultOn,
      ...(d.requires ? { requires: d.requires } : {}),
    })),
    canEdit: await canManage(ctx.pool, user.id, p),
    autoStart: s.autoStart,
    repos: (await liveRepos(ctx.pool, projectId)).map((r) => ({
      id: r.id,
      name: r.name,
      guidePath: s.guidePaths[r.id] ?? null,
    })),
    defaultGuidePath: DEFAULT_GUIDE_PATH,
  };
}

export async function setReleaseDocsPrepSettings(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  input: {
    enabled: boolean;
    steps: Record<string, boolean>;
    guidePaths?: Record<string, string>;
    autoStart?: boolean;
  },
): Promise<void> {
  const unknown = Object.keys(input.steps).filter((id) => !isReleaseDocsPrepStep(id));
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await requireManager(tx, user, projectId);
    if (unknown.length > 0)
      throw badRequest('unknown_step', `unknown release prep step: ${unknown.join(', ')}`);
    const before = settingsOf(p);
    // Check every path first, so a request applies completely or not at all.
    const live = new Map((await liveRepos(tx, projectId)).map((r) => [r.id, r.name]));
    const guidePaths: Record<string, string> = {};
    for (const [id, path] of Object.entries(before.guidePaths)) if (live.has(id)) guidePaths[id] = path;
    for (const [id, raw] of Object.entries(input.guidePaths ?? {})) {
      const name = live.get(id);
      if (name === undefined) throw badRequest('unknown_repo', `unknown repository: ${id}`);
      const c = normalizeGuidePath(raw);
      if (!c.ok)
        throw badRequest('invalid_guide_path', `The user guide path for ${name} ${c.reason}: ${raw.trim()}`);
      if (c.path) guidePaths[id] = c.path;
      else delete guidePaths[id];
    }
    const samePaths =
      Object.keys(guidePaths).length === Object.keys(before.guidePaths).length &&
      Object.entries(guidePaths).every(([id, v]) => before.guidePaths[id] === v);
    const steps = Object.fromEntries(
      releaseDocsPrepSteps().map((d) => [d.id, input.steps[d.id] ?? before.steps[d.id] ?? d.defaultOn]),
    );
    const autoStart = input.autoStart ?? before.autoStart;
    const same =
      samePaths &&
      before.autoStart === autoStart &&
      before.enabled === input.enabled &&
      releaseDocsPrepSteps().every((d) => (before.steps[d.id] ?? d.defaultOn) === steps[d.id]);
    if (same) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ReleaseDocsPrepSettingsSet',
            payload: { projectId, enabled: input.enabled, steps, guidePaths, autoStart, setBy: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

// ------------------------------------------------------------------------------------------------------------ repos

interface PrepRepo {
  id: string;
  name: string;
  branch: string;
  main_branch: string | null;
  remote_url_normalized: string;
  forge_kind: string | null;
}

/** The repositories a run covers: every one whose release branch differs from its main branch. */
export async function docsPrepRepos(db: Queryable, projectId: string): Promise<PrepRepo[]> {
  const all = await rows(
    db,
    `SELECT r.id, r.name, r.working_branch, r.main_branch, r.remote_url_normalized, r.forge_kind, p.working_branch AS project_branch
       FROM project_repos r JOIN projects p ON p.id = r.project_id
      WHERE r.project_id=$1 AND r.removed_at IS NULL ORDER BY r.name, r.id`,
    [projectId],
  );
  const out: PrepRepo[] = [];
  for (const r of all) {
    const branch = repoReleaseBranch(r);
    if (branch)
      out.push({
        id: r.id,
        name: r.name,
        branch,
        main_branch: r.main_branch ?? null,
        remote_url_normalized: r.remote_url_normalized,
        forge_kind: r.forge_kind ?? null,
      });
  }
  return out;
}

/**
 * The release branch a run is labelled and keyed with: the branch every included repository releases from when they
 * all agree; otherwise (none, or different branches) the project's working branch, else the first repository's.
 */
export function docsPrepReleaseBranch(
  projectBranch: string | null,
  repos: { branch: string }[],
): string | null {
  const first = repos[0]?.branch;
  if (first && repos.every((r) => r.branch === first)) return first;
  return projectBranch ?? first ?? null;
}

export async function releaseBranchOf(
  db: Queryable,
  projectId: string,
  projectBranch: string | null,
): Promise<string | null> {
  return docsPrepReleaseBranch(projectBranch, await docsPrepRepos(db, projectId));
}

async function prepWorkstation(db: Queryable, repoId: string, userId: string | null): Promise<string | null> {
  const ws = await one(
    db,
    `SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE wr.project_repo_id=$1 AND w.status='active' AND w.connected AND $3 = ANY (wc.capabilities)
      ORDER BY (w.user_id = $2::uuid) DESC, w.last_seen_at DESC NULLS LAST LIMIT 1`,
    [repoId, userId, RELEASE_DOCS_PREP_CAPABILITY],
  );
  return ws?.id ?? null;
}

// ------------------------------------------------------------------------------------------------------------ start

const timeOf = (d: Date | string): string => new Date(d).toISOString().slice(11, 16);

type Picked = { repoId: string; branch: string; mainBranch: string | null; workstationId: string };

/**
 * Every check a start makes, in order, with the sentence the manager sees. `p` is the project row (with
 * `simulation`); the caller holds its lock when it goes on to start. Throws the conflict that blocks the start.
 */
async function startChecks(
  db: Queryable,
  p: Row,
  userId: string | null,
  retryOf?: string,
): Promise<{ branch: string; picked: Picked[] }> {
  const projectId = String(p.id);
  if (!settingsOf(p).enabled) throw conflict('release_docs_prep_off', `${NAME} is switched off for this project.`);
  const missing = missingReleaseDocsPrepRequirement(enabledReleaseDocsPrepSteps(settingsOf(p)));
  if (missing) throw conflict('release_docs_prep_requires', missing.message);
  const repos = isResearchStage(p.workflow_key) || p.simulation ? [] : await docsPrepRepos(db, projectId);
  const branch: string | null = docsPrepReleaseBranch(p.working_branch ?? null, repos);
  if (repos.length === 0 || !branch)
    throw conflict(
      'no_release_branch',
      'No repository of this project has a release branch that differs from its main branch, so there is nothing to prepare.',
    );
  const running = await one(
    db,
    `SELECT started_at FROM release_docs_prep_runs WHERE project_id=$1 AND release_branch=$2 AND status='running'`,
    [projectId, branch],
  );
  if (running)
    throw conflict(
      'release_docs_prep_running',
      `${NAME} is already running for ${branch}, started at ${timeOf(running.started_at)}. Wait for it to finish.`,
    );
  if (retryOf) {
    const latest = await latestRun(db, projectId, branch);
    if (!latest || latest.status !== 'failed' || latest.id !== retryOf)
      throw conflict('not_failed', 'Only the latest run, when it failed, can be retried.');
  }
  const approved = await one(
    db,
    `SELECT 1 FROM release_proposals WHERE project_id=$1 AND state='approved' LIMIT 1`,
    [projectId],
  );
  if (approved)
    throw conflict('release_shipping', `A release is being shipped for ${branch}. ${NAME} belongs before the approval.`);
  const picked: Picked[] = [];
  for (const r of repos) {
    const ws = await prepWorkstation(db, r.id, userId);
    if (!ws) {
      const clone = await one(db, 'SELECT 1 FROM workstation_repos WHERE project_repo_id=$1', [r.id]);
      throw clone
        ? conflict(
            'runner_too_old',
            `The workstation that has ${r.name} is offline or needs a newer runner. Start or update the runner and try again.`,
          )
        : conflict('no_clone', `No workstation has ${r.name} yet. Wait for the clone to finish, then try again.`);
    }
    picked.push({ repoId: r.id, branch: r.branch, mainBranch: r.main_branch, workstationId: ws });
  }
  return { branch, picked };
}

/** Loads and locks the project row a start works on. */
export async function lockProjectForStart(tx: Queryable, projectId: string): Promise<Row> {
  const p = await one(
    tx,
    `SELECT p.*, o.simulation FROM projects p LEFT JOIN organizations o ON o.id = p.org_id WHERE p.id=$1 FOR UPDATE OF p`,
    [projectId],
  );
  if (!p) throw notFound('project not found');
  return p;
}

/** Who starts a run: a manager (a start or a retry), or the automatic start when the release is ready. */
export type DocsPrepStarter =
  | { kind: 'user'; userId: string; retryOf?: string }
  | { kind: 'auto'; heads: Record<string, string>; readyKey: string };

/** Runs every check and appends the Started event in the caller's transaction (project row already locked). */
export async function startRunInTx(
  ctx: Ctx,
  tx: Tx,
  p: Row,
  starter: DocsPrepStarter,
): Promise<{ runId: string; deliver: string[] }> {
  const projectId = String(p.id);
  const userId = starter.kind === 'user' ? starter.userId : null;
  const retryOf = starter.kind === 'user' ? starter.retryOf : undefined;
  const { branch, picked } = await startChecks(tx, p, userId, retryOf);
  const runId = randomUUID();
  const heads =
    starter.kind === 'auto' ? starter.heads : await knownHeads(tx, picked.map((x) => x.repoId));
  await ctx.store.append(
    [
      {
        streamId: streamId.releaseDocsPrep(runId),
        event: {
          type: 'ReleaseDocsPrepStarted',
          payload: {
            runId,
            projectId,
            releaseBranch: branch,
            steps: enabledReleaseDocsPrepSteps(settingsOf(p)).map((s) => s.id),
            repos: picked,
            trigger: retryOf ? 'retry' : starter.kind === 'auto' ? 'auto' : 'manual',
            ...(retryOf ? { retryOf } : {}),
            startedBy: userId,
            ...(Object.keys(heads).length > 0 ? { heads } : {}),
            ...(starter.kind === 'auto' ? { readyKey: starter.readyKey } : {}),
          },
        },
        actor: userId ? userActor(userId) : SYSTEM_ACTOR,
        scope: projectScope(p.org_id, projectId),
      },
    ],
    { tx },
  );
  return { runId, deliver: await advance(ctx, tx, runId) };
}

/** The release-branch heads the facts know for these repositories. */
async function knownHeads(db: Queryable, repoIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of repoIds) {
    const f = await loadFacts(db, id);
    if (f?.headSha) out[id] = f.headSha;
  }
  return out;
}

/**
 * Why a start would be refused right now, with the manual start's own sentence; null when it would go ahead.
 * Read only: nothing is started or locked.
 */
export async function startBlocker(db: Queryable, projectId: string): Promise<{ code: string; message: string } | null> {
  const p = await one(
    db,
    `SELECT p.*, o.simulation FROM projects p LEFT JOIN organizations o ON o.id = p.org_id WHERE p.id=$1`,
    [projectId],
  );
  if (!p) return null;
  try {
    await startChecks(db, p, null);
    return null;
  } catch (err) {
    if (err instanceof HttpError) return { code: err.code, message: err.message };
    throw err;
  }
}

export function deliverAll(ctx: Ctx, workstations: string[]): void {
  for (const w of new Set(workstations))
    void Promise.resolve(ctx.services.gateway.deliverPending(w)).catch(() => undefined);
}

/** Starts a run (or a retry of a failed one). One at a time per release; refused while a ship is approved. */
export async function startReleaseDocsPrep(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  opts: { retryOf?: string } = {},
): Promise<{ runId: string }> {
  const out = await withAppendTx(ctx.pool, async (tx) => {
    await requireManager(tx, user, projectId);
    const p = await lockProjectForStart(tx, projectId);
    return startRunInTx(ctx, tx, p, {
      kind: 'user',
      userId: user.id,
      ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
    });
  });
  deliverAll(ctx, out.deliver);
  return { runId: out.runId };
}

export const retryReleaseDocsPrep = (
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  runId: string,
): Promise<{ runId: string }> => startReleaseDocsPrep(ctx, user, projectId, { retryOf: runId });

// ------------------------------------------------------------------------------------------------------------- skip

export async function skipReleaseDocsPrep(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    await requireManager(tx, user, projectId);
    const p = await one(tx, 'SELECT * FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    if (!p) throw notFound('project not found');
    const branch: string | null = await releaseBranchOf(tx, projectId, p.working_branch ?? null);
    if (!branch) throw conflict('no_release_branch', 'This project has no release branch.');
    const latest = await latestRun(tx, projectId, branch);
    if (latest && (latest.status === 'passed' || latest.status === 'skipped'))
      throw conflict('not_skippable', `${NAME} already ${latest.status} for ${branch}: nothing to skip.`);
    const wasStatus = latest ? (latest.status as 'failed' | 'running') : 'not_run';
    const runId = latest?.id ?? randomUUID();
    await ctx.store.append(
      [
        {
          streamId: streamId.releaseDocsPrep(runId),
          event: {
            type: 'ReleaseDocsPrepSkipped',
            payload: { runId, projectId, releaseBranch: branch, skippedBy: user.id, wasStatus },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/**
 * The latest run for a release branch. By default a run that started before the last published ship of any of the
 * project's repositories belongs to an earlier release and counts as no run (same rule as the ship gate); the gate
 * passes `any` and applies the rule per repository itself.
 */
export async function latestRun(db: Queryable, projectId: string, branch: string, any = false): Promise<Row | null> {
  const fresh = any
    ? ''
    : `AND started_at >= COALESCE((SELECT MAX(s.published_at) FROM release_ships s JOIN project_repos pr ON pr.id = s.repo_id
                                   WHERE pr.project_id = $1 AND s.status='published'), '-infinity'::timestamptz)`;
  const r = await one(
    db,
    `SELECT * FROM release_docs_prep_runs WHERE project_id=$1 AND release_branch=$2 ${fresh} ORDER BY started_at DESC, id DESC LIMIT 1`,
    [projectId, branch],
  );
  return r ?? null;
}

// ----------------------------------------------------------------------------------------------------------- advance

async function snapshot(tx: Queryable, runId: string): Promise<{ run: Row; snap: RunSnapshot } | null> {
  const run = await one(tx, 'SELECT * FROM release_docs_prep_runs WHERE id=$1', [runId]);
  if (!run) return null;
  const repos = await rows(
    tx,
    `SELECT r.*, pr.name AS repo_name FROM release_docs_prep_repos r JOIN project_repos pr ON pr.id = r.repo_id WHERE r.run_id=$1 ORDER BY pr.name`,
    [runId],
  );
  const steps = await rows(tx, 'SELECT * FROM release_docs_prep_steps WHERE run_id=$1', [runId]);
  return {
    run,
    snap: {
      status: run.status,
      steps: run.steps,
      repos: repos.map((r) => ({
        repoId: r.repo_id,
        repoName: r.repo_name,
        state: r.state,
        steps: steps
          .filter((s) => s.repo_id === r.repo_id)
          .map((s) => ({ step: s.step, phase: s.phase as string, state: s.state, error: s.error })),
      })),
    },
  };
}

/**
 * Dispatches whatever comes next for the run, or finishes it. Returns the workstations to deliver to after the commit.
 * Runs in the transaction that changed the run.
 */
export async function advance(ctx: Ctx, tx: Tx, runId: string): Promise<string[]> {
  // Skipped later phases and server phases finish in this transaction; then plan again. Bounded by the step rows.
  for (let guard = 0; guard < 500; guard++) {
    const s = await snapshot(tx, runId);
    if (!s || s.run.status !== 'running') return [];
    const action = nextReleaseDocsPrepAction(s.snap);
    if (action.kind === 'skip') {
      for (const repoId of action.repoIds)
        await finishInline(ctx, tx, s.run, repoId, action.step, action.phase, {
          state: 'skipped',
          error: action.notes[repoId] ?? `${action.step} skipped`,
        });
      continue;
    }
    if (action.kind === 'dispatch' && action.by === 'server') {
      const handler = SERVER_PHASES[`${action.step}/${action.phase ?? ''}`];
      for (const repoId of action.repoIds) {
        // A step with a writer phase needs a runner that takes writer tasks, before its first phase (here a server phase).
        if (!(await writerStepGate(ctx, tx, s.run, repoId, action.step, action.phase ?? ''))) continue;
        const out = handler
          ? await handler(ctx, tx, s.run, repoId)
          : { state: 'failed' as const, error: `no server phase ${action.step}/${action.phase}` };
        await finishInline(ctx, tx, s.run, repoId, action.step, action.phase ?? '', out);
      }
      continue;
    }
    return dispatchAction(ctx, tx, s.run, action);
  }
  return [];
}

/** A phase the server finishes itself (skipped after a skipped earlier phase, or a server phase): started, then done. */
async function finishInline(
  ctx: Ctx,
  tx: Tx,
  run: Row,
  repoId: string,
  step: string,
  phase: string,
  out: ServerPhaseOutcome,
): Promise<void> {
  const scope = projectScope(run.org_id, run.project_id);
  const actor = run.started_by ? userActor(run.started_by) : SYSTEM_ACTOR;
  const base = { runId: run.id as string, repoId, step, ...(phase ? { phase } : {}) };
  const started = {
    streamId: streamId.releaseDocsPrep(run.id),
    event: { type: 'ReleaseDocsPrepStepStarted' as const, payload: base },
    actor,
    scope,
  };
  // A phase waiting for its tasks stays running; the last task's end finishes it (docs-prep-tasks.ts).
  if (out.state === 'running') {
    await ctx.store.append([started], { tx });
    return;
  }
  await ctx.store.append(
    [
      started,
      {
        streamId: streamId.releaseDocsPrep(run.id),
        event: {
          type: 'ReleaseDocsPrepStepFinished',
          payload: {
            ...base,
            state: out.state,
            ...(out.error ? { error: out.error.slice(0, 4000) } : {}),
            files: [],
            ...(out.report ? { report: out.report } : {}),
          },
        },
        actor,
        scope,
      },
    ],
    { tx },
  );
}

async function dispatchAction(
  ctx: Ctx,
  tx: Tx,
  run: Row,
  action: Exclude<ReleaseDocsPrepAction, { kind: 'skip' }>,
): Promise<string[]> {
  const runId: string = run.id;
  const scope = projectScope(run.org_id, run.project_id);
  const actor = run.started_by ? userActor(run.started_by) : SYSTEM_ACTOR;
  if (action.kind === 'wait') return [];
  if (action.kind === 'finish') {
    await ctx.store.append(
      [
        {
          streamId: streamId.releaseDocsPrep(runId),
          event: {
            type: 'ReleaseDocsPrepFinished',
            payload:
              action.status === 'passed'
                ? { runId, status: 'passed' }
                : { runId, status: 'failed', step: action.step, repoId: action.repoId, error: action.error },
          },
          actor,
          scope,
        },
      ],
      { tx },
    );
    return [];
  }
  const project = await one(tx, 'SELECT key, name FROM projects WHERE id=$1', [run.project_id]);
  const commitAs = await loadCommitAs(tx, run.project_id);
  const deliver: string[] = [];
  let failedHere = false;
  for (const repoId of action.repoIds) {
    const repo = await one(
      tx,
      `SELECT r.*, pr.remote_url_normalized, pr.forge_kind, pr.name FROM release_docs_prep_repos r
         JOIN project_repos pr ON pr.id = r.repo_id WHERE r.run_id=$1 AND r.repo_id=$2`,
      [runId, repoId],
    );
    if (!repo) continue;
    const summary = repo.summary ? ReleaseDocsPrepSummarySchema.safeParse(repo.summary) : null;
    // A step with a writer phase needs a runner that takes writer tasks, before its first phase (here a runner phase).
    if (!(await writerStepGate(ctx, tx, run, repoId, action.step, action.phase ?? ''))) {
      failedHere = true;
      continue;
    }
    if (action.step === 'guide' && (action.phase ?? '') === 'check') {
      const configured = await guidePathFor(tx, run.project_id, repoId);
      if (configured) {
        const cap = await one(
          tx,
          'SELECT 1 FROM workstation_capabilities WHERE workstation_id=$1 AND $2 = ANY (capabilities)',
          [repo.workstation_id, RELEASE_DOCS_PREP_GUIDE_PATH_CAPABILITY],
        );
        if (!cap) {
          await failStepBeforeDispatch(
            ctx,
            tx,
            run,
            repoId,
            action.step,
            `The workstation that has ${repo.name} needs a newer runner to use the user guide path ${configured}. Update the runner and retry.`,
            action.phase,
          );
          failedHere = true;
          continue;
        }
      }
    }
    const hook = DOCS_PREP_STEP_HOOKS[action.step];
    const stepInput = hook?.stepInput ? await hook.stepInput(tx, run, repo) : undefined;
    const inputOf = PHASE_INPUTS[`${action.step}/${action.phase ?? ''}`];
    const input = inputOf ? await inputOf(tx, runId, repoId) : undefined;
    // The changelog's apply phase sends its checked entries as `payload.changelog` (the runner's changelog step reads it,
    // and an older runner can apply them too); every other phase gets its earlier phase's result as `input`.
    const changelog: ReleaseDocsPrepPayload['changelog'] =
      action.step === 'changelog'
        ? { projectName: project?.name ?? '', entries: [], ...(input ?? {}) }
        : undefined;
    deliver.push(
      await sendDocsPrepStepCommand(ctx, tx, run, repo, {
        step: action.step,
        ...(action.phase ? { phase: action.phase } : {}),
        projectKey: project?.key ?? '',
        commitAs: commitAs ?? null,
        ...(changelog ? { changelog } : {}),
        ...(stepInput ? { stepInput } : {}),
        ...(input && !changelog ? { input } : {}),
      }),
    );
  }
  // A step that failed before anything was sent finishes the run now (nothing is committed).
  if (failedHere) deliver.push(...(await advance(ctx, tx, runId)));
  return deliver;
}

/**
 * Every step with a writer phase (changelog, guide, videos) needs a runner on the repository's workstation that takes
 * release prep writer tasks. Checked once, before the step's first phase, so an older runner fails with one clear message
 * instead of half-running the step. Returns false when it failed the row (the run then fails).
 */
async function writerStepGate(
  ctx: Ctx,
  tx: Tx,
  run: Row,
  repoId: string,
  step: string,
  phase: string,
): Promise<boolean> {
  const def = releaseDocsPrepStep(step);
  if (!def?.writerPhase) return true;
  const first = def.phases?.[0] ?? '';
  if (phase !== first) return true;
  const repo = await one(
    tx,
    `SELECT r.workstation_id, pr.name FROM release_docs_prep_repos r JOIN project_repos pr ON pr.id = r.repo_id
      WHERE r.run_id=$1 AND r.repo_id=$2`,
    [run.id, repoId],
  );
  if (!repo) return true;
  const cap = await one(
    tx,
    'SELECT 1 FROM workstation_capabilities WHERE workstation_id=$1 AND $2 = ANY (capabilities)',
    [repo.workstation_id, RELEASE_DOCS_PREP_WRITER_TASKS_CAPABILITY],
  );
  if (cap) return true;
  await failStepBeforeDispatch(
    ctx,
    tx,
    run,
    repoId,
    step,
    `${def.label} needs a newer runner on the workstation that has ${repo.name}. Update the runner and retry prep.`,
    phase,
  );
  return false;
}

/** A (step, repository) that fails before a command is sent: started and failed at once, with the reason. */
async function failStepBeforeDispatch(
  ctx: Ctx,
  tx: Tx,
  run: Row,
  repoId: string,
  step: string,
  error: string,
  phase?: string,
): Promise<void> {
  const runId: string = run.id;
  const scope = projectScope(run.org_id, run.project_id);
  const actor = run.started_by ? userActor(run.started_by) : SYSTEM_ACTOR;
  const at = phase ? { phase } : {};
  await ctx.store.append(
    [
      {
        streamId: streamId.releaseDocsPrep(runId),
        event: { type: 'ReleaseDocsPrepStepStarted', payload: { runId, repoId, step, ...at } },
        actor,
        scope,
      },
      {
        streamId: streamId.releaseDocsPrep(runId),
        event: {
          type: 'ReleaseDocsPrepStepFinished',
          payload: { runId, repoId, step, ...at, state: 'failed', error, files: [] },
        },
        actor,
        scope,
      },
    ],
    { tx },
  );
}

/**
 * Sends one `release.docs_prep` command for a (step, repository) of a running run and marks the step running. Returns
 * the workstation to deliver to after the commit. `repo` is a release_docs_prep_repos row joined with project_repos.
 */
export async function sendDocsPrepStepCommand(
  ctx: Ctx,
  tx: Tx,
  run: Row,
  repo: Row,
  o: {
    step: string;
    phase?: string;
    projectKey: string;
    commitAs: ReleaseDocsPrepPayload['commitAs'];
    changelog?: ReleaseDocsPrepPayload['changelog'];
    stepInput?: ReleaseDocsPrepPayload['stepInput'];
    input?: ReleaseDocsPrepPayload['input'];
  },
): Promise<string> {
  const runId: string = run.id;
  const repoId: string = repo.repo_id;
  const summary = repo.summary ? ReleaseDocsPrepSummarySchema.safeParse(repo.summary) : null;
  const payload: ReleaseDocsPrepPayload = {
    runId,
    projectId: run.project_id,
    repoId,
    remoteUrlNormalized: repo.remote_url_normalized,
    ...(repo.forge_kind ? { forge: repo.forge_kind } : {}),
    releaseBranch: repo.branch,
    ...(repo.main_branch ? { mainBranch: repo.main_branch } : {}),
    step: o.step,
    ...(o.phase ? { phase: o.phase } : {}),
    components: await loadComponentRules(tx, repoId),
    projectKey: o.projectKey,
    ...(summary?.success ? { summary: summary.data } : {}),
    ...(repo.base_sha ? { base: { sha: repo.base_sha, tag: repo.base_tag ?? null } } : {}),
    message: `docs(release): prepare the release documentation for ${repo.branch}`,
    commitAs: o.commitAs ?? null,
    ...(o.changelog ? { changelog: o.changelog } : {}),
    ...(o.stepInput ? { stepInput: o.stepInput } : {}),
    ...(o.input ? { input: o.input } : {}),
  };
  const commandId = await enqueueRunnerCommand(tx, repo.workstation_id, 'release.docs_prep', payload);
  await ctx.store.append(
    [
      {
        streamId: streamId.releaseDocsPrep(runId),
        event: {
          type: 'ReleaseDocsPrepStepStarted',
          payload: { runId, repoId, step: o.step, ...(o.phase ? { phase: o.phase } : {}), commandId },
        },
        actor: run.started_by ? userActor(run.started_by) : SYSTEM_ACTOR,
        scope: projectScope(run.org_id, run.project_id),
      },
    ],
    { tx },
  );
  return repo.workstation_id;
}

// ------------------------------------------------------------------------------------------------------------ result

/** The runner's answer to `release.docs_prep`. A late or foreign answer (wrong run, step or workstation) is ignored. */
export async function applyReleaseDocsPrepResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const runId = String(payload.runId ?? '');
  const repoId = String(payload.repoId ?? '');
  const step = String(payload.step ?? '');
  const asked = typeof payload.phase === 'string' ? payload.phase : '';
  const phase = asked && stepPhases(step).includes(asked) ? asked : undefined;
  const parsed = ReleaseDocsPrepResultSchema.safeParse(result);
  const r = ok && parsed.success ? parsed.data : undefined;
  const deliver: string[] = [];
  let committed = false;
  let repoIds: string[] = [];
  let projectId = '';
  let userId: string | undefined;
  await withAppendTx(ctx.pool, async (tx) => {
    const run = await one(tx, 'SELECT * FROM release_docs_prep_runs WHERE id=$1 FOR UPDATE', [runId]);
    if (!run || run.status !== 'running') return;
    const row = await one(
      tx,
      `SELECT s.state, r.workstation_id FROM release_docs_prep_steps s
         JOIN release_docs_prep_repos r ON r.run_id = s.run_id AND r.repo_id = s.repo_id
        WHERE s.run_id=$1 AND s.repo_id=$2 AND s.step=$3 AND s.phase=$4`,
      [runId, repoId, step, phase ?? ''],
    );
    if (!row || row.state !== 'running' || row.workstation_id !== workstationId) return;
    const state = r ? r.state : 'failed';
    let message = r ? r.error : (error ?? (parsed.success ? parsed.data.error : undefined));
    let report = r?.report;
    if (report && JSON.stringify(report).length > REPORT_MAX_BYTES) {
      report = { truncated: true };
      message = `${message ?? ''} (report too large)`.trim();
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.releaseDocsPrep(runId),
          event: {
            type: 'ReleaseDocsPrepStepFinished',
            payload: {
              runId,
              repoId,
              step,
              ...(phase ? { phase } : {}),
              state,
              ...(state === 'failed'
                ? { error: (message ?? 'the workstation could not run this step').slice(0, 4000) }
                : message
                  ? { error: message.slice(0, 4000) }
                  : {}),
              files: r?.files ?? [],
              ...(r?.summary ? { summary: r.summary } : {}),
              ...(r && step === 'analyse' ? { baseTag: r.baseTag ?? null } : {}),
              ...(r?.baseSha ? { baseSha: r.baseSha } : {}),
              ...(r?.headSha ? { headSha: r.headSha } : {}),
              ...(r?.commit ? { commit: r.commit } : {}),
              ...(phase === 'push' && state === 'passed' && r?.commit ? { pushed: true } : {}),
              ...(() => {
                const output = r ? storedStepOutput(step, r.output, payload.changelog) : undefined;
                return output === undefined ? {} : { output };
              })(),
              ...(report ? { report } : {}),
            },
          },
          actor: run.started_by ? userActor(run.started_by) : SYSTEM_ACTOR,
          scope: projectScope(run.org_id, run.project_id),
        },
      ],
      { tx },
    );
    // A failed phase may get one more round (videos: a newly written script whose render failed) instead of failing.
    const onFailure = PHASE_FAILURE_HOOKS[`${step}/${phase ?? ''}`];
    if (state === 'failed' && onFailure) await onFailure(ctx, tx, run, repoId);
    deliver.push(...(await advance(ctx, tx, runId)));
    const after = await one(tx, 'SELECT status FROM release_docs_prep_runs WHERE id=$1', [runId]);
    if (after?.status === 'passed') {
      committed = true;
      projectId = run.project_id;
      userId = run.started_by ?? undefined;
      repoIds = (
        await rows(
          tx,
          'SELECT repo_id FROM release_docs_prep_repos WHERE run_id=$1 AND commit_sha IS NOT NULL',
          [runId],
        )
      ).map((x) => x.repo_id);
    }
  });
  for (const w of new Set(deliver))
    void Promise.resolve(ctx.services.gateway.deliverPending(w)).catch(() => undefined);
  // The Ship release item must read the prep commit: ask for fresh facts of every repo that got one.
  if (committed && projectId)
    for (const id of repoIds)
      await requestReleaseFacts(ctx, id, 'manual', { ...(userId ? { userId } : {}) }).catch(() => undefined);
}

// ------------------------------------------------------------------------------------------------------------- gate

/**
 * The gate at the start of a ship. Off: one read of the switch and `allowed`. On: the latest run for the project's
 * release branch, the repository's row in it and the facts the owner is approving.
 */
export async function loadReleaseDocsPrepGate(
  db: Queryable,
  proposal: Row,
): Promise<ReturnType<typeof releaseDocsPrepGate>> {
  const p = await one(
    db,
    `SELECT p.release_docs_prep, p.working_branch, COALESCE(r.working_branch, p.working_branch) AS repo_branch
       FROM projects p JOIN project_repos r ON r.id = $2 WHERE p.id = $1`,
    [proposal.project_id, proposal.repo_id],
  );
  if (!p || settingsOf(p).enabled !== true) return { allowed: true };
  const input = await gateInput(db, proposal, p);
  return releaseDocsPrepGate(input);
}

async function gateInput(db: Queryable, proposal: Row, p: Row): Promise<ReleaseDocsPrepGateInput> {
  const branch: string =
    (await releaseBranchOf(db, proposal.project_id, p.working_branch ?? null)) ?? p.repo_branch ?? '';
  const run = branch ? await latestRun(db, proposal.project_id, branch, true) : null;
  const repoRow = run
    ? await one(db, 'SELECT * FROM release_docs_prep_repos WHERE run_id=$1 AND repo_id=$2', [
        run.id,
        proposal.repo_id,
      ])
    : null;
  const failedRepo = run?.failed_repo_id
    ? await one(db, 'SELECT name FROM project_repos WHERE id=$1', [run.failed_repo_id])
    : null;
  const published = await one(
    db,
    `SELECT MAX(published_at) AS at FROM release_ships WHERE repo_id=$1 AND status='published'`,
    [proposal.repo_id],
  );
  const f = await loadFacts(db, proposal.repo_id);
  return {
    enabled: true,
    releaseBranch: branch,
    run: run
      ? {
          id: run.id,
          status: run.status,
          startedAt: new Date(run.started_at).toISOString(),
          failedStep: run.failed_step ?? null,
          failedRepoName: failedRepo?.name ?? null,
        }
      : null,
    repo: repoRow
      ? {
          inRun: true,
          baseTag: repoRow.base_tag ?? null,
          commitSha: repoRow.commit_sha ?? null,
          analysed: repoRow.summary != null,
        }
      : null,
    lastPublishedAt: published?.at ? new Date(published.at).toISOString() : null,
    proposalLastTag: proposal.last_tag ?? null,
    facts: f?.facts
      ? {
          headSha: f.facts.headSha,
          commitShas: f.facts.commits.map((c) => c.sha),
          truncated: f.facts.commitsTruncated,
        }
      : null,
  };
}

/**
 * What the Ship release item and the repo row show. `undefined` when the switch is off, so DTOs look exactly as before.
 */
export async function releaseDocsPrepViewFor(
  db: Queryable,
  proposal: Row,
): Promise<ReleaseDocsPrepGateView | undefined> {
  const p = await one(db, 'SELECT release_docs_prep, working_branch FROM projects WHERE id=$1', [
    proposal.project_id,
  ]);
  if (!p || settingsOf(p).enabled !== true) return undefined;
  const gate = await loadReleaseDocsPrepGate(db, proposal);
  const link = releaseDocsPrepLink(proposal.project_id);
  return gate.allowed ? { blocked: false, link } : { blocked: true, message: gate.message, link };
}

// ------------------------------------------------------------------------------------------------------------- views

async function runDto(db: Queryable, run: Row): Promise<ReleaseDocsPrepRunDto> {
  const repos = await rows(
    db,
    `SELECT r.*, pr.name AS repo_name FROM release_docs_prep_repos r JOIN project_repos pr ON pr.id = r.repo_id
      WHERE r.run_id=$1 ORDER BY pr.name`,
    [run.id],
  );
  const steps = await rows(db, 'SELECT * FROM release_docs_prep_steps WHERE run_id=$1', [run.id]);
  const order = new Map((run.steps as string[]).map((s, i) => [s, i]));
  const failedRepo = run.failed_repo_id ? repos.find((r) => r.repo_id === run.failed_repo_id) : undefined;
  const starter = run.started_by
    ? await one(db, 'SELECT display_name FROM users WHERE id=$1', [run.started_by])
    : null;
  return {
    id: run.id,
    projectId: run.project_id,
    releaseBranch: run.release_branch,
    status: run.status,
    trigger: run.trigger,
    retryOf: run.retry_of ?? null,
    startedBy: run.started_by ?? null,
    startedByName: starter?.display_name ?? null,
    startedAt: iso(run.started_at) as string,
    finishedAt: iso(run.finished_at),
    failed: run.failed_step
      ? {
          step: run.failed_step,
          repoId: run.failed_repo_id ?? null,
          repoName: failedRepo?.repo_name ?? null,
          error: run.error ?? '',
        }
      : null,
    skippedBy: run.skipped_by ?? null,
    skippedAt: iso(run.skipped_at),
    steps: run.steps,
    repos: repos.map((r) => {
      const sum = r.summary ? ReleaseDocsPrepSummarySchema.safeParse(r.summary) : null;
      return {
        repoId: r.repo_id,
        repoName: r.repo_name,
        branch: r.branch,
        state: r.state,
        baseTag: r.base_tag ?? null,
        headSha: r.head_sha ?? null,
        commitSha: r.commit_sha ?? null,
        pushed: !!r.pushed,
        summary: sum?.success ? sum.data : null,
        steps: steps
          .filter((s) => s.repo_id === r.repo_id)
          .sort(
            (a, b) =>
              (order.get(a.step) ?? 99) - (order.get(b.step) ?? 99) ||
              stepPhaseIndex(a.step, a.phase) - stepPhaseIndex(b.step, b.phase),
          )
          .map((s) => ({
            step: s.step,
            phase: s.phase,
            state: s.state,
            startedAt: iso(s.started_at),
            finishedAt: iso(s.finished_at),
            error: s.error ?? null,
            files: s.files ?? [],
            ...(s.output != null ? { output: s.output } : {}),
            report: s.report ?? null,
          })),
      };
    }),
  };
}

export async function getReleaseDocsPrepRun(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  runId: string | 'latest',
): Promise<ReleaseDocsPrepRunDto | null> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const run =
    runId === 'latest'
      ? await (async () => {
          const b = await releaseBranchOf(ctx.pool, projectId, p.working_branch ?? null);
          return b ? latestRun(ctx.pool, projectId, b) : null;
        })()
      : await one(ctx.pool, 'SELECT * FROM release_docs_prep_runs WHERE id=$1 AND project_id=$2', [
          runId,
          projectId,
        ]);
  if (runId !== 'latest' && !run) throw notFound('run not found');
  return run ? runDto(ctx.pool, run) : null;
}

/** The Releases page tab: the projects the user sees that use release prep (the switch is on, or a run exists). */
export async function releaseDocsPrepOverview(
  ctx: Ctx,
  user: AuthSession['user'],
  orgId: string | null,
): Promise<ReleaseDocsPrepOverviewItem[]> {
  const projects = await rows(
    ctx.pool,
    `SELECT p.*, pm.role AS my_role FROM projects p JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active'
      WHERE p.status='active' AND p.kind='project' AND ($2::uuid IS NULL OR p.org_id = $2)
        AND (COALESCE((p.release_docs_prep->>'enabled')::boolean, false)
             OR EXISTS (SELECT 1 FROM release_docs_prep_runs x WHERE x.project_id = p.id))
      ORDER BY p.name`,
    [user.id, orgId],
  );
  const out: ReleaseDocsPrepOverviewItem[] = [];
  for (const p of projects) {
    const branch = await releaseBranchOf(ctx.pool, p.id, p.working_branch ?? null);
    const run = branch ? await latestRun(ctx.pool, p.id, branch) : null;
    const settings = settingsOf(p);
    const enabled = settings.enabled;
    const state: ReleaseDocsPrepState = run ? run.status : enabled ? 'not_run' : 'off';
    const autoStart = enabled && settings.autoStart;
    const readiness = autoStart && branch ? await loadReleaseReadiness(ctx.pool, p, ctx.clock.now()) : null;
    const autoStartBlocked =
      readiness?.ready && !run ? ((await startBlocker(ctx.pool, p.id))?.message ?? null) : null;
    out.push({
      projectId: p.id,
      key: p.key,
      name: p.name,
      enabled,
      releaseBranch: branch,
      state,
      canAct: enabled && (await canManage(ctx.pool, user.id, p)),
      run: run ? await runDto(ctx.pool, run) : null,
      autoStart,
      readiness: readiness
        ? { ready: readiness.ready, repos: readiness.repos, reasons: readiness.reasons }
        : null,
      autoStartBlocked,
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ sweep

/** A step that got no answer for 12 hours fails, so a lost workstation cannot hold the release forever. */
export async function releaseDocsPrepSweep(ctx: Ctx): Promise<void> {
  const cutoff = new Date(ctx.clock.now().getTime() - SWEEP_MS);
  const stale = await rows(
    ctx.pool,
    `SELECT s.run_id, s.repo_id, s.step, s.phase, r.workstation_id FROM release_docs_prep_steps s
       JOIN release_docs_prep_runs u ON u.id = s.run_id
       JOIN release_docs_prep_repos r ON r.run_id = s.run_id AND r.repo_id = s.repo_id
      WHERE s.state='running' AND u.status='running' AND s.started_at < $1`,
    [cutoff],
  );
  for (const s of stale) {
    await applyReleaseDocsPrepResult(
      ctx,
      s.workstation_id,
      { runId: s.run_id, repoId: s.repo_id, step: s.step, ...(s.phase ? { phase: s.phase } : {}) },
      false,
      undefined,
      'no answer from the workstation within 12 hours',
    );
  }
}
