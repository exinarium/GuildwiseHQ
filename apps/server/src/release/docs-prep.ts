import { randomUUID } from 'node:crypto';
import {
  enabledReleaseDocsPrepSteps,
  isOrgManager,
  isReleaseDocsPrepStep,
  isResearchStage,
  missingReleaseDocsPrepRequirement,
  nextReleaseDocsPrepAction,
  RELEASE_DOCS_PREP_CAPABILITY,
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
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { changelogDispatchFor, queueChangelogTask, storedStepOutput } from './docs-prep-changelog.ts';
import { DOCS_PREP_STEP_HOOKS, docsPrepWriter } from './docs-prep-steps.ts';
import {
  PHASE_FAILURE_HOOKS,
  PHASE_INPUTS,
  REPORT_MAX_BYTES,
  SERVER_PHASES,
  type ServerPhaseOutcome,
} from './docs-prep-videos.ts';
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

function settingsOf(p: Row): { enabled: boolean; steps: Record<string, boolean> } {
  const s = (p.release_docs_prep ?? {}) as { enabled?: unknown; steps?: Record<string, unknown> };
  const steps: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(s.steps ?? {})) if (typeof v === 'boolean') steps[k] = v;
  return { enabled: s.enabled === true, steps };
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
  };
}

export async function setReleaseDocsPrepSettings(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  input: { enabled: boolean; steps: Record<string, boolean> },
): Promise<void> {
  const unknown = Object.keys(input.steps).filter((id) => !isReleaseDocsPrepStep(id));
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await requireManager(tx, user, projectId);
    if (unknown.length > 0)
      throw badRequest('unknown_step', `unknown release prep step: ${unknown.join(', ')}`);
    const before = settingsOf(p);
    const steps = Object.fromEntries(
      releaseDocsPrepSteps().map((d) => [d.id, input.steps[d.id] ?? before.steps[d.id] ?? d.defaultOn]),
    );
    const same =
      before.enabled === input.enabled &&
      releaseDocsPrepSteps().every((d) => (before.steps[d.id] ?? d.defaultOn) === steps[d.id]);
    if (same) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ReleaseDocsPrepSettingsSet',
            payload: { projectId, enabled: input.enabled, steps, setBy: user.id },
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

async function prepWorkstation(db: Queryable, repoId: string, userId: string): Promise<string | null> {
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

/** Starts a run (or a retry of a failed one). One at a time per release; refused while a ship is approved. */
export async function startReleaseDocsPrep(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  opts: { retryOf?: string } = {},
): Promise<{ runId: string }> {
  const deliver: string[] = [];
  const runId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await requireManager(tx, user, projectId);
    const p = await one(
      tx,
      `SELECT p.*, o.simulation FROM projects p LEFT JOIN organizations o ON o.id = p.org_id WHERE p.id=$1 FOR UPDATE OF p`,
      [projectId],
    );
    if (!p) throw notFound('project not found');
    if (!settingsOf(p).enabled)
      throw conflict('release_docs_prep_off', `${NAME} is switched off for this project.`);
    const missing = missingReleaseDocsPrepRequirement(enabledReleaseDocsPrepSteps(settingsOf(p)));
    if (missing) throw conflict('release_docs_prep_requires', missing.message);
    const repos = isResearchStage(p.workflow_key) || p.simulation ? [] : await docsPrepRepos(tx, projectId);
    const branch: string | null = p.working_branch ?? repos[0]?.branch ?? null;
    if (repos.length === 0 || !branch)
      throw conflict(
        'no_release_branch',
        'No repository of this project has a release branch that differs from its main branch, so there is nothing to prepare.',
      );
    const running = await one(
      tx,
      `SELECT started_at FROM release_docs_prep_runs WHERE project_id=$1 AND release_branch=$2 AND status='running'`,
      [projectId, branch],
    );
    if (running)
      throw conflict(
        'release_docs_prep_running',
        `${NAME} is already running for ${branch}, started at ${timeOf(running.started_at)}. Wait for it to finish.`,
      );
    if (opts.retryOf) {
      const latest = await latestRun(tx, projectId, branch);
      if (!latest || latest.status !== 'failed' || latest.id !== opts.retryOf)
        throw conflict('not_failed', 'Only the latest run, when it failed, can be retried.');
    }
    const approved = await one(
      tx,
      `SELECT 1 FROM release_proposals WHERE project_id=$1 AND state='approved' LIMIT 1`,
      [projectId],
    );
    if (approved)
      throw conflict(
        'release_shipping',
        `A release is being shipped for ${branch}. ${NAME} belongs before the approval.`,
      );
    const picked: { repoId: string; branch: string; mainBranch: string | null; workstationId: string }[] = [];
    for (const r of repos) {
      const ws = await prepWorkstation(tx, r.id, user.id);
      if (!ws) {
        const clone = await one(tx, 'SELECT 1 FROM workstation_repos WHERE project_repo_id=$1', [r.id]);
        throw clone
          ? conflict(
              'runner_too_old',
              `The workstation that has ${r.name} is offline or needs a newer runner. Start or update the runner and try again.`,
            )
          : conflict(
              'no_clone',
              `No workstation has ${r.name} yet. Wait for the clone to finish, then try again.`,
            );
      }
      picked.push({ repoId: r.id, branch: r.branch, mainBranch: r.main_branch, workstationId: ws });
    }
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
              trigger: opts.retryOf ? 'retry' : 'manual',
              ...(opts.retryOf ? { retryOf: opts.retryOf } : {}),
              startedBy: user.id,
            },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    deliver.push(...(await advance(ctx, tx, runId)));
  });
  for (const w of new Set(deliver))
    void Promise.resolve(ctx.services.gateway.deliverPending(w)).catch(() => undefined);
  return { runId };
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
    const branch: string | null = p.working_branch ?? (await docsPrepRepos(tx, projectId))[0]?.branch ?? null;
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
async function latestRun(db: Queryable, projectId: string, branch: string, any = false): Promise<Row | null> {
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
    let changelog: ReleaseDocsPrepPayload['changelog'];
    if (action.step === 'changelog') {
      const d = await changelogDispatchFor(tx, run, repo, summary?.success ? summary.data : null);
      if (d.kind === 'fail') {
        await failStepBeforeDispatch(ctx, tx, run, repoId, action.step, d.error);
        failedHere = true;
        continue;
      }
      if (d.kind === 'write') {
        // The entries for new changes are written by a BA first; its accepted report sends the runner command.
        await queueChangelogTask(ctx, tx, run, repoId);
        continue;
      }
      changelog = { projectName: project?.name ?? '', entries: [] };
    }
    const hook = action.phase ? undefined : DOCS_PREP_STEP_HOOKS[action.step];
    let writer: ReleaseDocsPrepPayload['writer'] | null = null;
    if (hook?.needsWriter) {
      writer = await docsPrepWriter(ctx, tx, run, repo);
      if (!writer) {
        // Not dispatched: the step fails here with the reason (Retry or Skip), as for 'changelog' above.
        await failStepBeforeDispatch(
          ctx,
          tx,
          run,
          repoId,
          action.step,
          `no agent on the workstation that has ${repo.name} can write the release documentation`,
        );
        failedHere = true;
        continue;
      }
    }
    const stepInput = hook?.stepInput ? await hook.stepInput(tx, run, repo) : undefined;
    const inputOf = PHASE_INPUTS[`${action.step}/${action.phase ?? ''}`];
    const input = inputOf ? await inputOf(tx, runId, repoId) : undefined;
    deliver.push(
      await sendDocsPrepStepCommand(ctx, tx, run, repo, {
        step: action.step,
        ...(action.phase ? { phase: action.phase } : {}),
        projectKey: project?.key ?? '',
        commitAs: commitAs ?? null,
        ...(changelog ? { changelog } : {}),
        ...(stepInput ? { stepInput } : {}),
        ...(writer ? { writer } : {}),
        ...(input ? { input } : {}),
      }),
    );
  }
  // A step that failed before anything was sent finishes the run now (nothing is committed).
  if (failedHere) deliver.push(...(await advance(ctx, tx, runId)));
  return deliver;
}

/** A (step, repository) that fails before a command is sent: started and failed at once, with the reason. */
async function failStepBeforeDispatch(
  ctx: Ctx,
  tx: Tx,
  run: Row,
  repoId: string,
  step: string,
  error: string,
): Promise<void> {
  const runId: string = run.id;
  const scope = projectScope(run.org_id, run.project_id);
  const actor = run.started_by ? userActor(run.started_by) : SYSTEM_ACTOR;
  await ctx.store.append(
    [
      {
        streamId: streamId.releaseDocsPrep(runId),
        event: { type: 'ReleaseDocsPrepStepStarted', payload: { runId, repoId, step } },
        actor,
        scope,
      },
      {
        streamId: streamId.releaseDocsPrep(runId),
        event: {
          type: 'ReleaseDocsPrepStepFinished',
          payload: { runId, repoId, step, state: 'failed', error, files: [] },
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
    phase?: CommitPhase;
    projectKey: string;
    commitAs: ReleaseDocsPrepPayload['commitAs'];
    changelog?: ReleaseDocsPrepPayload['changelog'];
    stepInput?: ReleaseDocsPrepPayload['stepInput'];
    writer?: ReleaseDocsPrepPayload['writer'];
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
    ...(o.writer ? { writer: o.writer } : {}),
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
  const branch: string = p.working_branch ?? p.repo_branch ?? '';
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
  return {
    id: run.id,
    projectId: run.project_id,
    releaseBranch: run.release_branch,
    status: run.status,
    trigger: run.trigger,
    retryOf: run.retry_of ?? null,
    startedBy: run.started_by ?? null,
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
      ? p.working_branch
        ? await latestRun(ctx.pool, projectId, p.working_branch)
        : null
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
    const branch: string | null = p.working_branch ?? null;
    const run = branch ? await latestRun(ctx.pool, p.id, branch) : null;
    const enabled = settingsOf(p).enabled;
    const state: ReleaseDocsPrepState = run ? run.status : enabled ? 'not_run' : 'off';
    out.push({
      projectId: p.id,
      key: p.key,
      name: p.name,
      enabled,
      releaseBranch: branch,
      state,
      canAct: enabled && (await canManage(ctx.pool, user.id, p)),
      run: run ? await runDto(ctx.pool, run) : null,
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
