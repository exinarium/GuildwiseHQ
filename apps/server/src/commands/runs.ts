import { createHash, randomUUID } from 'node:crypto';
import {
  branchName,
  DEFAULT_MAX_RUN_ENVIRONMENTS,
  DEFAULT_RUN_PORT_RANGE,
  DEFAULT_RUN_TTL_HOURS,
  type DevopsRun,
  type ExtendRunRequest,
  isLiveRunState,
  isOrgManager,
  isSafeGitRef,
  type RestartRunRequest,
  RUN_WORKTREE_KEEP_HOURS,
  type RunEnvironmentDto,
  type RunnerToServerOf,
  type RunPlan,
  type RunPlanDto,
  RunPlanSchema,
  type RunReplayFailedMsg,
  type RunRestartPayload,
  type RunSettingsResponse,
  RunSettingsSchema,
  type RunStartPayload,
  type RunStatus,
  RunStatusSchema,
  type SetRunSettingsRequest,
  type StartRunRequest,
  streamId,
  validateRunPlan,
  validateRunSettings,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, loadVisibleProject, visibleProjectIds } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, runnerActor, SYSTEM_ACTOR, userActor } from './common.ts';
import { createDevOpsRequestIn, threadMessage } from './devops.ts';
import { rebaseConflictEvents } from './rebase.ts';
import { deliver } from './workstation-setup.ts';

/**
 * Run a branch (backlog #58, docs/design/run-and-integration-tests.md). A start creates the environment row, asks the
 * runner to prepare the run worktrees (`run.start`) and files a DevOps `run` request: the DevOps engineer of that
 * workstation works out how to run the project and starts the services through `aom run`, so the runner, not the
 * Claude session, owns the processes. Process state comes back as `run.status`.
 */

/** A `requested` environment the runner never answered is given up after this long. */
const REQUESTED_TIMEOUT_MS = 10 * 60_000;
/** A replay the runner reported nothing about for this long is given up (the runner reports at every step). */
const REPLAY_TIMEOUT_MS = 30 * 60_000;
/** A finished DevOps `run` request whose environment is still not ready is given up after this grace period. */
const REQUEST_DONE_GRACE_MS = 30_000;

// -------------------------------------------------------------------------------------------- DTOs

const ENV_SQL = `SELECT e.*, p.key AS project_key, p.name AS project_name, w.name AS workstation_name, w.user_id AS ws_user_id,
       c.ref AS card_ref, u.display_name AS requested_by_name,
       (SELECT jsonb_object_agg(r.id::text, r.name) FROM project_repos r WHERE r.project_id = e.project_id) AS repo_names,
       COALESCE((SELECT 'runs:2' = ANY(c2.capabilities) FROM workstation_capabilities c2 WHERE c2.workstation_id = e.workstation_id), false) AS ws_replay
  FROM run_environments e JOIN projects p ON p.id = e.project_id JOIN workstations w ON w.id = e.workstation_id
  LEFT JOIN cards c ON c.id = e.card_id LEFT JOIN users u ON u.id = e.requested_by`;

/** Who may stop and extend an environment: its starter, the workstation's owner, and the organization's Owners and Admins. */
async function mayManage(db: Queryable, userId: string, r: Row): Promise<boolean> {
  if (r.requested_by === userId || r.ws_user_id === userId) return true;
  return isOrgManager({ orgRole: await orgRoleOf(db, userId, r.org_id) });
}

/** A stopped manual environment keeps its run worktrees (and can be revived) for this long. */
const KEEP_MS = RUN_WORKTREE_KEEP_HOURS * 3600_000;

/** Can this environment be restarted now: running and ready, or stopped, manual, with a plan and its worktrees still kept? */
function restartable(r: Row, now: Date): 'live' | 'revive' | null {
  if (!r.ws_replay) return null;
  if (['healthy', 'degraded'].includes(r.state)) return 'live';
  if (
    r.state === 'stopped' &&
    r.purpose === 'manual' &&
    r.plan_version !== null &&
    ['stopped', 'ttl'].includes(r.stop_reason ?? '') &&
    r.stopped_at &&
    now.getTime() - new Date(r.stopped_at).getTime() < KEEP_MS
  )
    return 'revive';
  return null;
}

async function toDto(
  db: Queryable,
  userId: string,
  r: Row,
  now: Date = new Date(),
): Promise<RunEnvironmentDto> {
  const names = (r.repo_names ?? {}) as Record<string, string>;
  const manage = await mayManage(db, userId, r);
  const live = isLiveRunState(r.state);
  return {
    id: r.id,
    projectId: r.project_id,
    projectKey: r.project_key,
    projectName: r.project_name,
    workstationId: r.workstation_id,
    workstationName: r.workstation_name,
    purpose: r.purpose,
    cardId: r.card_id ?? null,
    cardRef: r.card_ref ?? null,
    sources: ((r.sources ?? []) as Array<{ repoId: string; branch: string; commit?: string | null }>).map(
      (s) => ({
        repoId: s.repoId,
        repoName: names[s.repoId] ?? 'repository',
        branch: s.branch,
        commit: s.commit ?? null,
      }),
    ),
    services: r.services ?? [],
    state: r.state,
    servicesStatus: r.services_status ?? [],
    activity: r.activity ?? null,
    planVersion: r.plan_version ?? null,
    requestedBy: { id: r.requested_by ?? null, name: r.requested_by_name ?? null },
    devopsRequestId: r.devops_request_id ?? null,
    createdAt: iso(r.created_at) as string,
    healthyAt: iso(r.healthy_at),
    expiresAt: iso(r.expires_at),
    stoppedAt: iso(r.stopped_at),
    stopReason: r.stop_reason ?? null,
    lastError: r.last_error ?? null,
    canStop: live && r.state !== 'stopping' && manage,
    canExtend: live && r.state !== 'stopping' && manage && r.expires_at !== null,
    canRestart: manage && restartable(r, now) !== null,
    replayed: r.replayed === true,
  };
}

export async function listRuns(
  ctx: Ctx,
  userId: string,
  q: { projectId?: string; cardId?: string; workstationId?: string; live?: boolean },
): Promise<RunEnvironmentDto[]> {
  const visible = await visibleProjectIds(ctx.pool, userId);
  const list = await rows(
    ctx.pool,
    `${ENV_SQL} WHERE (e.project_id = ANY($1::uuid[]) OR w.user_id = $2)
        AND ($3::uuid IS NULL OR e.project_id = $3) AND ($4::uuid IS NULL OR e.card_id = $4)
        AND ($5::uuid IS NULL OR e.workstation_id = $5)
        AND ($6::boolean IS NOT TRUE OR e.state NOT IN ('stopped','failed'))
      ORDER BY e.created_at DESC, e.id LIMIT 100`,
    [visible, userId, q.projectId ?? null, q.cardId ?? null, q.workstationId ?? null, q.live ?? true],
  );
  return Promise.all(list.map((r) => toDto(ctx.pool, userId, r, ctx.clock.now())));
}

async function loadEnv(db: Queryable, userId: string, id: string, forUpdate = false): Promise<Row> {
  const r = await one(db, `${ENV_SQL} WHERE e.id=$1${forUpdate ? ' FOR UPDATE OF e' : ''}`, [id]);
  if (!r) throw notFound('environment not found');
  const visible = new Set(await visibleProjectIds(db, userId));
  if (!visible.has(r.project_id) && r.ws_user_id !== userId) throw notFound('environment not found');
  return r;
}

export async function getRun(ctx: Ctx, userId: string, id: string): Promise<RunEnvironmentDto> {
  return toDto(ctx.pool, userId, await loadEnv(ctx.pool, userId, id), ctx.clock.now());
}

// ------------------------------------------------------------------------------------------- settings

export async function getRunSettings(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<RunSettingsResponse> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const repos = await rows(
    ctx.pool,
    'SELECT id, name, run_instructions FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name, id',
    [projectId],
  );
  const plans = await rows(
    ctx.pool,
    `SELECT rp.*, w.name AS workstation_name FROM run_plans rp JOIN workstations w ON w.id = rp.workstation_id
      WHERE rp.project_id=$1 AND rp.status <> 'superseded' AND w.status='active' ORDER BY w.name`,
    [projectId],
  );
  return {
    runInstructions: p.run_instructions ?? '',
    repos: repos.map((r) => ({ repoId: r.id, name: r.name, runInstructions: r.run_instructions ?? '' })),
    settings: RunSettingsSchema.parse(p.run_settings ?? {}),
    plans: plans.map(
      (r): RunPlanDto => ({
        id: r.id,
        workstationId: r.workstation_id,
        workstationName: r.workstation_name,
        version: r.version,
        status: r.status,
        plan: RunPlanSchema.parse(r.plan),
        savedAt: iso(r.created_at) as string,
      }),
    ),
  };
}

/** "Run & test" settings: same permission as the other Project settings (the project owner). */
export async function setRunSettings(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: SetRunSettingsRequest,
): Promise<void> {
  const problems = validateRunSettings(req.settings);
  if (problems.length) throw badRequest('invalid_run_settings', problems.join('; '));
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const repoIds = new Set(
      (
        await rows<{ id: string }>(
          tx,
          'SELECT id FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
          [projectId],
        )
      ).map((r) => r.id),
    );
    for (const s of req.settings.services)
      if (!repoIds.has(s.repoId))
        throw badRequest('unknown_repo', `service "${s.name}" names a repository that is not in the project`);
    for (const r of req.repoInstructions)
      if (!repoIds.has(r.repoId))
        throw badRequest('unknown_repo', 'run instructions name a repository that is not in the project');
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectRunSettingsSet',
            payload: {
              projectId,
              runInstructions: req.runInstructions,
              repoInstructions: req.repoInstructions.filter((r) => r.runInstructions.trim() !== ''),
              settings: req.settings,
              by: user.id,
            },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    await staleCheck(ctx, tx, projectId);
  });
}

// ------------------------------------------------------------------------------------------ fingerprint

/**
 * The server's half of a plan's fingerprint: the run instructions (project and per repository) and the structured
 * fields. The runner's half is the hash of BUILD.md. A change to either makes the plan stale (design section 2.2).
 */
export async function settingsHashOf(db: Queryable, projectId: string): Promise<string> {
  const project = await one(db, 'SELECT run_instructions, run_settings FROM projects WHERE id=$1', [
    projectId,
  ]);
  const repos = await rows(
    db,
    'SELECT id, run_instructions FROM project_repos WHERE project_id=$1 ORDER BY id',
    [projectId],
  );
  return createHash('sha256')
    .update(
      JSON.stringify([
        project?.run_instructions ?? '',
        repos.map((x) => [x.id, x.run_instructions ?? '']),
        project?.run_settings ?? {},
      ]),
    )
    .digest('hex');
}

/** Does the plan cover this start: every repository it uses is among the chosen ones, and every wanted service is in it? */
function planCovers(plan: RunPlan, repoIds: string[], wanted: string[]): boolean {
  if (plan.services.length === 0) return false;
  const have = new Set(repoIds);
  if ([...plan.setup, ...plan.services].some((x) => !have.has(x.repoId))) return false;
  return wanted.every((w) => plan.services.some((s) => s.name.toLowerCase() === w.toLowerCase()));
}

/** Marks a plan stale (an event: `RunPlanMarkedStale`); the next start goes through the DevOps engineer. */
async function markPlanStale(ctx: Ctx, tx: Tx, plan: Row, reason: 'settings' | 'build_doc'): Promise<void> {
  if (plan.status !== 'active') return;
  await ctx.store.append(
    [
      {
        streamId: streamId.project(plan.project_id),
        event: {
          type: 'RunPlanMarkedStale',
          payload: {
            planId: plan.id,
            projectId: plan.project_id,
            workstationId: plan.workstation_id,
            reason,
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(plan.org_id, plan.project_id),
      },
    ],
    { tx },
  );
}

/** After the settings changed: every active plan whose settings half no longer matches is stale. */
async function staleCheck(ctx: Ctx, tx: Tx, projectId: string): Promise<void> {
  const hash = await settingsHashOf(tx, projectId);
  const plans = await rows(tx, `SELECT * FROM run_plans WHERE project_id=$1 AND status='active'`, [
    projectId,
  ]);
  for (const pl of plans)
    if (pl.settings_hash !== null && pl.settings_hash !== hash) await markPlanStale(ctx, tx, pl, 'settings');
}

// ------------------------------------------------------------------------------------------ start

export const branchKey = (sources: Array<{ repoId: string; branch: string }>): string =>
  createHash('sha1')
    .update(
      sources
        .map((s) => `${s.repoId}:${s.branch}`)
        .sort()
        .join('|'),
    )
    .digest('hex');

export async function capsOf(db: Queryable, workstationId: string) {
  const c = await one(
    db,
    'SELECT capabilities, max_run_environments FROM workstation_capabilities WHERE workstation_id=$1',
    [workstationId],
  );
  return {
    runs: ((c?.capabilities ?? []) as string[]).includes('runs:1'),
    /** `runs:2`: plan replay, Restart and the service sandbox. */
    replay: ((c?.capabilities ?? []) as string[]).includes('runs:2'),
    /** `runs:3`: test environments for cards (rebase of the card branch, forwarders, suites). */
    testEnv: ((c?.capabilities ?? []) as string[]).includes('runs:3'),
    max: (c?.max_run_environments as number | null) ?? DEFAULT_MAX_RUN_ENVIRONMENTS,
  };
}

/**
 * The saved plan the runner may replay for these repositories and services (no model call), or nothing: no runner
 * support, no plan, a stale one (marked here when the settings changed), or a plan that does not cover what is asked.
 */
export async function findReplay(
  ctx: Ctx,
  tx: Tx,
  projectId: string,
  workstationId: string,
  runnerReplays: boolean,
  repoIds: string[],
  services: string[],
): Promise<{ replay?: NonNullable<RunStartPayload['replay']>; planRow?: Row }> {
  if (!runnerReplays) return {};
  const planRow = await one(
    tx,
    `SELECT * FROM run_plans WHERE project_id=$1 AND workstation_id=$2 AND status='active'`,
    [projectId, workstationId],
  );
  if (!planRow || planRow.settings_hash === null || planRow.build_hash === null) return {};
  if (planRow.settings_hash !== (await settingsHashOf(tx, projectId))) {
    await markPlanStale(ctx, tx, planRow, 'settings');
    return {};
  }
  const plan = RunPlanSchema.safeParse(planRow.plan);
  if (!plan.success || !planCovers(plan.data, repoIds, services)) return {};
  return {
    planRow,
    replay: {
      planId: planRow.id,
      version: planRow.version,
      plan: plan.data,
      buildHash: planRow.build_hash,
    },
  };
}

/** Starts a branch on a workstation: the environment row, `run.start` for the runner and a DevOps `run` request. */
export async function startRun(
  ctx: Ctx,
  user: AuthSession['user'],
  req: StartRunRequest,
): Promise<RunEnvironmentDto> {
  const now = ctx.clock.now();
  const envId = randomUUID();
  const result = await withAppendTx(ctx.pool, async (tx) => {
    const project = await loadVisibleProject(tx, user.id, req.projectId);
    if (project.status === 'archived') throw conflict('project_archived', 'this project is archived');
    const card = req.cardId ? (await loadVisibleCard(tx, user.id, req.cardId)).card : undefined;
    if (card && card.project_id !== project.id) throw notFound('card not found');

    // The workstation: named, else the card's own, else the user's only connected one that holds the repositories.
    let wsId = req.workstationId ?? (card?.home_workstation_id as string | undefined);
    if (!wsId) {
      const mine = await rows<{ id: string }>(
        tx,
        `SELECT w.id FROM workstations w WHERE w.user_id=$1 AND w.status='active' ORDER BY w.connected DESC, w.paired_at`,
        [user.id],
      );
      wsId = mine[0]?.id;
    }
    if (!wsId) throw conflict('no_workstation', 'you have no workstation to run it on');
    const ws = await one(
      tx,
      `SELECT id, user_id, name, connected FROM workstations WHERE id=$1 AND status='active'`,
      [wsId],
    );
    if (!ws) throw notFound('workstation not found');
    const manager = isOrgManager({ orgRole: await orgRoleOf(tx, user.id, project.org_id) });
    if (ws.user_id !== user.id && !manager) throw notFound('workstation not found');
    const caps = await capsOf(tx, ws.id);
    if (!caps.runs)
      throw conflict(
        'runs_not_supported',
        `the runner on ${ws.name} is too old to run a branch: update the runner on that machine`,
      );
    if (!ws.connected) throw conflict('workstation_offline', `${ws.name} is offline`);

    // Repositories: the project's, cloned on this workstation.
    const repos = await rows(
      tx,
      `SELECT pr.id, pr.name, pr.remote_url_normalized, pr.working_branch, pr.project_path
         FROM project_repos pr JOIN workstation_repos wr ON wr.project_repo_id = pr.id AND wr.workstation_id = $2
        WHERE pr.project_id=$1 AND pr.removed_at IS NULL ORDER BY pr.name, pr.id`,
      [project.id, ws.id],
    );
    const cardBranch = card
      ? ((card.worktree_card_id
          ? await one(tx, 'SELECT branch_name, ref, title FROM cards WHERE id=$1', [card.worktree_card_id])
          : card
        )?.branch_name ?? branchName(project.branch_prefix, card.ref, card.title))
      : null;
    const wanted = new Map((req.sources ?? []).map((s) => [s.repoId, s.branch]));
    for (const id of wanted.keys())
      if (!repos.some((r) => r.id === id))
        throw conflict(
          'repo_not_cloned',
          'a chosen repository is not part of the project or not cloned on this workstation',
        );
    const sources = repos.map((r) => {
      const branch =
        wanted.get(r.id) ??
        (card && card.repo_id === r.id && cardBranch ? cardBranch : null) ??
        r.working_branch ??
        project.working_branch;
      return { repo: r, branch: branch as string };
    });
    // With explicit sources only those repositories run; otherwise every cloned repository does.
    const chosen = wanted.size ? sources.filter((s) => wanted.has(s.repo.id)) : sources;
    if (card && card.repo_id && !chosen.some((s) => s.repo.id === card.repo_id))
      throw conflict('repo_not_cloned', 'the card repository is not cloned on this workstation');
    if (chosen.length === 0)
      throw conflict('repo_not_cloned', 'no repository of this project is cloned on this workstation');
    for (const s of chosen)
      if (!isSafeGitRef(s.branch))
        throw badRequest('invalid_branch', `"${s.branch}" is not a valid branch name`);

    const key = branchKey(chosen.map((s) => ({ repoId: s.repo.id, branch: s.branch })));
    const same = await one(
      tx,
      `SELECT id, state FROM run_environments WHERE workstation_id=$1 AND project_id=$2 AND branch_key=$3
          AND purpose='manual' AND state NOT IN ('stopped','failed')`,
      [ws.id, project.id, key],
    );
    if (same)
      throw conflict('already_running', 'this branch is already running on that workstation', {
        envId: same.id,
      });
    const live = await rows(
      tx,
      `SELECT e.id, p.key AS project_key, e.sources FROM run_environments e JOIN projects p ON p.id = e.project_id
        WHERE e.workstation_id=$1 AND e.state NOT IN ('stopped','failed') ORDER BY e.created_at`,
      [ws.id],
    );
    if (live.length >= caps.max)
      throw conflict(
        'run_cap',
        `${ws.name} already runs ${live.length} environment${live.length === 1 ? '' : 's'} (the limit is ${caps.max}): stop one first`,
        { running: live.map((l) => ({ id: l.id, projectKey: l.project_key })) },
      );

    const settings = RunSettingsSchema.parse(project.run_settings ?? {});
    const ttlHours = settings.ttlHours || DEFAULT_RUN_TTL_HOURS;
    const expiresAt = new Date(now.getTime() + ttlHours * 3600_000);
    const sourcesJson = chosen.map((s) => ({ repoId: s.repo.id, branch: s.branch, commit: null }));
    const summary = `Run ${chosen.map((s) => `${s.repo.name}@${s.branch}`).join(', ')} of ${project.name}${card ? ` (card ${card.ref})` : ''}`;

    // A current saved plan is replayed by the runner with no model call; anything else goes through the DevOps engineer.
    const { replay, planRow: replayPlanRow } = await findReplay(
      ctx,
      tx,
      project.id,
      ws.id,
      caps.replay,
      chosen.map((c) => c.repo.id),
      req.services ?? [],
    );
    await exec(
      tx,
      `INSERT INTO run_environments (id, org_id, project_id, workstation_id, purpose, card_id, sources, services, state,
          requested_by, branch_key, created_at, updated_at, expires_at, replayed, plan_id, plan_version)
       VALUES ($1,$2,$3,$4,'manual',$5,$6::jsonb,$7::text[],'requested',$8,$9,$10,$10,$11,$12,$13,$14)`,
      [
        envId,
        project.org_id,
        project.id,
        ws.id,
        card?.id ?? null,
        JSON.stringify(sourcesJson),
        req.services ?? [],
        user.id,
        key,
        now,
        expiresAt,
        !!replay,
        replayPlanRow?.id ?? null,
        replayPlanRow?.version ?? null,
      ],
    );
    let requestId: string | null = null;
    if (!replay) {
      requestId = (
        await createDevOpsRequestIn(ctx, tx, {
          workstationId: ws.id,
          orgId: project.org_id,
          summary: req.note ? `${summary}\n\n${req.note}` : summary,
          requestedBy: { kind: 'user', id: user.id, name: user.displayName },
          ...(card ? { cardId: card.id } : {}),
          origin: card ? 'card' : 'workstation',
          context: {
            projectId: project.id,
            workstationId: ws.id,
            ...(card ? { cardId: card.id } : {}),
            requestKind: 'run',
            envId,
          },
        })
      ).requestId;
      await exec(tx, 'UPDATE run_environments SET devops_request_id=$2 WHERE id=$1', [envId, requestId]);
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.run(envId),
          event: {
            type: 'RunEnvironmentRequested',
            payload: {
              envId,
              projectId: project.id,
              workstationId: ws.id,
              purpose: 'manual',
              ...(card ? { cardId: card.id } : {}),
              sources: sourcesJson,
              services: req.services ?? [],
              requestedBy: user.id,
              requestId,
              expiresAt: expiresAt.toISOString(),
            },
          },
          actor: userActor(user.id),
          scope: projectScope(project.org_id, project.id),
        },
      ],
      { tx },
    );
    const payload: RunStartPayload = {
      envId,
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
      purpose: 'manual',
      requestId,
      sources: chosen.map((s) => ({
        repoId: s.repo.id,
        name: s.repo.name,
        remoteUrlNormalized: s.repo.remote_url_normalized,
        branch: s.branch,
        ...(s.repo.project_path ? { projectPath: s.repo.project_path } : {}),
      })),
      services: req.services ?? [],
      portRange: { ...DEFAULT_RUN_PORT_RANGE },
      ttlAt: expiresAt.toISOString(),
      allowDocker: settings.allowDocker,
      ...(replay ? { replay } : {}),
    };
    await enqueueRunnerCommand(tx, ws.id, 'run.start', payload);
    return { wsId: ws.id };
  });
  deliver(ctx, [result.wsId]);
  ctx.services.dispatcher.trigger();
  return getRun(ctx, user.id, envId);
}

// ----------------------------------------------------------------------------------- stop and extend

/** Records the stop request and tells the runner. `by` null: the server itself (TTL, a finished request). */
export async function requestStopIn(
  ctx: Ctx,
  tx: Tx,
  r: Row,
  by: string | null,
  reason: 'stopped' | 'ttl' | 'failed' | 'verdict',
): Promise<void> {
  const now = ctx.clock.now();
  await exec(
    tx,
    `UPDATE run_environments SET state = CASE WHEN state IN ('stopped','failed') THEN state ELSE 'stopping' END,
            stop_requested_at=$2, updated_at=$2 WHERE id=$1`,
    [r.id, now],
  );
  await ctx.store.append(
    [
      {
        streamId: streamId.run(r.id),
        event: { type: 'RunEnvironmentStopRequested', payload: { envId: r.id, by } },
        actor: by ? userActor(by) : SYSTEM_ACTOR,
        scope: projectScope(r.org_id, r.project_id),
      },
    ],
    { tx },
  );
  await enqueueRunnerCommand(tx, r.workstation_id, 'run.stop', { envId: r.id, reason });
  // A DevOps request that has not started yet has nothing left to do.
  if (r.devops_request_id) {
    const req = await one(tx, 'SELECT status, thread_id, org_id FROM devops_requests WHERE id=$1', [
      r.devops_request_id,
    ]);
    if (req?.status === 'queued')
      await ctx.store.append(
        [
          {
            streamId: streamId.thread(r.devops_request_id),
            event: {
              type: 'DevOpsRequestCompleted',
              payload: {
                requestId: r.devops_request_id,
                status: 'failed',
                summary: 'The environment was stopped before the DevOps engineer started.',
              },
            },
            actor: SYSTEM_ACTOR,
            scope: { orgId: req.org_id, projectId: null, audience: 'org' },
          },
        ],
        { tx },
      );
  }
}

export async function stopRun(ctx: Ctx, user: AuthSession['user'], id: string): Promise<RunEnvironmentDto> {
  const wsId = await withAppendTx(ctx.pool, async (tx) => {
    const r = await loadEnv(tx, user.id, id, true);
    if (!(await mayManage(tx, user.id, r)))
      throw forbidden(
        'only the person who started it, the workstation owner or an organization Owner or Admin can stop it',
      );
    if (!isLiveRunState(r.state) || r.state === 'stopping') return null;
    await requestStopIn(ctx, tx, r, user.id, 'stopped');
    return r.workstation_id as string;
  });
  if (wsId) deliver(ctx, [wsId]);
  ctx.services.browser.runChanged(id);
  return getRun(ctx, user.id, id);
}

/** Extend: moves the expiry `hours` (default: the project's TTL) past the later of now and the current expiry. */
export async function extendRun(
  ctx: Ctx,
  user: AuthSession['user'],
  id: string,
  req: ExtendRunRequest,
): Promise<RunEnvironmentDto> {
  const now = ctx.clock.now();
  const wsId = await withAppendTx(ctx.pool, async (tx) => {
    const r = await loadEnv(tx, user.id, id, true);
    if (!(await mayManage(tx, user.id, r))) throw forbidden('you cannot extend this environment');
    if (!isLiveRunState(r.state) || r.state === 'stopping')
      throw conflict('not_running', 'this environment is not running');
    if (!r.expires_at) throw conflict('no_expiry', 'this environment does not expire');
    const project = await one(tx, 'SELECT run_settings FROM projects WHERE id=$1', [r.project_id]);
    const hours = req.hours ?? RunSettingsSchema.parse(project?.run_settings ?? {}).ttlHours;
    const from = Math.max(now.getTime(), new Date(r.expires_at).getTime());
    const next = new Date(from + hours * 3600_000);
    await exec(tx, 'UPDATE run_environments SET expires_at=$2, updated_at=$3 WHERE id=$1', [r.id, next, now]);
    await enqueueRunnerCommand(tx, r.workstation_id, 'run.extend', {
      envId: r.id,
      ttlAt: next.toISOString(),
    });
    return r.workstation_id as string;
  });
  deliver(ctx, [wsId]);
  ctx.services.browser.runChanged(id);
  return getRun(ctx, user.id, id);
}

/**
 * Restart (same commit) or Update & restart (fast-forward the run worktrees to the branch head) of a running
 * environment, or of a stopped manual one whose worktrees the runner still keeps (a day). The runner may refuse (no plan,
 * a rewritten branch, the worktrees gone): its answer lands in `last_error`.
 */
export async function restartRun(
  ctx: Ctx,
  user: AuthSession['user'],
  id: string,
  req: RestartRunRequest,
): Promise<RunEnvironmentDto> {
  const now = ctx.clock.now();
  const wsId = await withAppendTx(ctx.pool, async (tx) => {
    const r = await loadEnv(tx, user.id, id, true);
    if (!(await mayManage(tx, user.id, r))) throw forbidden('you cannot restart this environment');
    if (!r.ws_replay)
      throw conflict(
        'runs_not_supported',
        'the runner on that workstation is too old to restart: update the runner on that machine',
      );
    const how = restartable(r, now);
    if (!how)
      throw conflict(
        'not_restartable',
        r.state === 'stopped'
          ? 'this environment can no longer be restarted (its worktrees are kept for a day after a stop): start the branch again'
          : 'only a running environment can be restarted',
      );
    const ws = await one(tx, 'SELECT connected, name FROM workstations WHERE id=$1', [r.workstation_id]);
    if (!ws?.connected) throw conflict('workstation_offline', `${ws?.name ?? 'the workstation'} is offline`);
    if (how === 'revive') {
      const other = await one(
        tx,
        `SELECT id FROM run_environments WHERE workstation_id=$1 AND project_id=$2 AND branch_key=$3
            AND purpose='manual' AND state NOT IN ('stopped','failed') AND id <> $4`,
        [r.workstation_id, r.project_id, r.branch_key, r.id],
      );
      if (other)
        throw conflict('already_running', 'this branch is already running on that workstation', {
          envId: other.id,
        });
      const caps = await capsOf(tx, r.workstation_id);
      const live = await one(
        tx,
        `SELECT count(*)::int AS n FROM run_environments WHERE workstation_id=$1 AND state NOT IN ('stopped','failed')`,
        [r.workstation_id],
      );
      if (Number(live?.n ?? 0) >= caps.max)
        throw conflict('run_cap', `that workstation already runs ${live?.n} environments: stop one first`);
    }
    const project = await one(tx, 'SELECT run_settings FROM projects WHERE id=$1', [r.project_id]);
    const hours = RunSettingsSchema.parse(project?.run_settings ?? {}).ttlHours;
    const expiresAt = new Date(now.getTime() + hours * 3600_000);
    await exec(
      tx,
      `UPDATE run_environments SET state='starting', activity=$2, expires_at=$3, healthy_at=NULL, stop_requested_at=NULL,
              devops_request_id=NULL, replayed=true, updated_at=$4 WHERE id=$1`,
      [r.id, req.update ? 'updating and restarting' : 'restarting', expiresAt, now],
    );
    await ctx.store.append(
      [
        {
          streamId: streamId.run(r.id),
          event: {
            type: 'RunEnvironmentRestarted',
            payload: { envId: r.id, by: user.id, update: !!req.update, revived: how === 'revive' },
          },
          actor: userActor(user.id),
          scope: projectScope(r.org_id, r.project_id),
        },
      ],
      { tx },
    );
    const payload: RunRestartPayload = {
      envId: r.id,
      update: !!req.update,
      ttlAt: expiresAt.toISOString(),
      revive: how === 'revive',
    };
    await enqueueRunnerCommand(tx, r.workstation_id, 'run.restart', payload);
    return r.workstation_id as string;
  });
  deliver(ctx, [wsId]);
  ctx.services.browser.runChanged(id);
  return getRun(ctx, user.id, id);
}

/** `command.result` of `run.restart`: a refusal puts the environment back as it was and says why. */
export async function applyRunRestartResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const res = (result ?? {}) as { ok?: boolean; error?: string };
  if (ok && res.ok !== false) return;
  const reason = (res.error ?? error ?? 'the runner could not restart the environment').slice(0, 2000);
  const now = ctx.clock.now();
  await withAppendTx(ctx.pool, async (tx) => {
    const r = await one(tx, 'SELECT * FROM run_environments WHERE id=$1 AND workstation_id=$2 FOR UPDATE', [
      String(payload.envId),
      workstationId,
    ]);
    if (!r) return;
    // A revived environment goes back to stopped; a running one was never touched by the runner (it keeps its state
    // until its next report), so only the reason is recorded.
    await exec(
      tx,
      `UPDATE run_environments SET last_error=$2, updated_at=$3,
              state = CASE WHEN $4::boolean AND state = 'starting' THEN 'stopped' ELSE state END
        WHERE id=$1`,
      [r.id, reason, now, payload.revive === true],
    );
  });
  ctx.services.browser.runChanged(String(payload.envId));
}

/**
 * `run.replay.failed`: the saved plan did not bring the environment up (or BUILD.md changed). The plan is marked stale
 * when its fingerprint no longer matches; a DevOps `run` request is filed to repair it, with the failure log tail.
 */
export async function applyRunReplayFailed(
  ctx: Ctx,
  tx: Tx,
  workstationId: string,
  msg: RunReplayFailedMsg,
): Promise<void> {
  const r = await one(tx, `${ENV_SQL} WHERE e.id=$1 AND e.workstation_id=$2 FOR UPDATE OF e`, [
    msg.envId,
    workstationId,
  ]);
  if (!r || !isLiveRunState(r.state) || r.state === 'stopping' || r.stop_requested_at) return;
  if (msg.stale && r.plan_id) {
    const plan = await one(tx, 'SELECT * FROM run_plans WHERE id=$1', [r.plan_id]);
    if (plan) await markPlanStale(ctx, tx, plan, 'build_doc');
  }
  // One DevOps request at a time: a repair already queued or running for this environment is enough.
  if (r.devops_request_id) {
    const open = await one(
      tx,
      `SELECT 1 AS x FROM devops_requests WHERE id=$1 AND status IN ('queued','running','needs_approval')`,
      [r.devops_request_id],
    );
    if (open) return;
  }
  const sources = (r.sources ?? []) as Array<{ repoId: string; branch: string }>;
  const names = (r.repo_names ?? {}) as Record<string, string>;
  const summary = `Run ${sources.map((s) => `${names[s.repoId] ?? 'repository'}@${s.branch}`).join(', ')} of ${r.project_name}${r.card_ref ? ` (card ${r.card_ref})` : ''}. The saved run plan failed (${msg.reason.slice(0, 300)}): repair it.`;
  const requester = r.requested_by
    ? {
        kind: 'user' as const,
        id: r.requested_by as string,
        name: (r.requested_by_name as string) ?? 'a user',
      }
    : { kind: 'system' as const, id: null };
  const { requestId } = await createDevOpsRequestIn(ctx, tx, {
    workstationId,
    orgId: r.org_id,
    summary,
    requestedBy: requester,
    ...(r.card_id ? { cardId: r.card_id } : {}),
    origin: r.card_id ? 'card' : 'workstation',
    context: {
      projectId: r.project_id,
      workstationId,
      ...(r.card_id ? { cardId: r.card_id } : {}),
      requestKind: 'run',
      envId: r.id,
      replayFailure: `${msg.reason}${msg.logTail ? `\n\nLast output:\n${msg.logTail}` : ''}`.slice(0, 12000),
    },
  });
  await exec(
    tx,
    `UPDATE run_environments SET devops_request_id=$2, state='starting', activity=$3, last_error=$4, updated_at=$5 WHERE id=$1`,
    [
      r.id,
      requestId,
      'the saved plan failed: waiting for the DevOps engineer',
      msg.reason.slice(0, 2000),
      ctx.clock.now(),
    ],
  );
}

// ------------------------------------------------------------------------------- runner reports

/** `run.status` from the runner: the state of an environment of this workstation. */
export async function applyRunStatus(ctx: Ctx, workstationId: string, raw: RunStatus): Promise<void> {
  const parsed = RunStatusSchema.safeParse(raw);
  if (!parsed.success) return;
  const msg = parsed.data;
  const now = ctx.clock.now();
  const changed = await withAppendTx(ctx.pool, async (tx) => {
    const r = await one(tx, `${ENV_SQL} WHERE e.id=$1 AND e.workstation_id=$2 FOR UPDATE OF e`, [
      msg.envId,
      workstationId,
    ]);
    if (!r) return false;
    if (r.state === 'stopped' || r.state === 'failed') return false; // final
    const stopping = r.stop_requested_at !== null;
    // The server's `stopping` wins over late reports of a running state.
    const state = stopping && msg.state !== 'stopped' && msg.state !== 'failed' ? 'stopping' : msg.state;
    const sources = (
      (r.sources ?? []) as Array<{ repoId: string; branch: string; commit: string | null }>
    ).map((s) => ({
      ...s,
      commit: msg.sources?.find((x) => x.repoId === s.repoId)?.commit ?? s.commit ?? null,
    }));
    const terminal = state === 'stopped' || state === 'failed';
    await exec(
      tx,
      `UPDATE run_environments SET state=$2::text, services_status=$3::jsonb, activity=$4::text, sources=$5::jsonb, updated_at=$6,
              last_error = CASE WHEN $7::text IS NOT NULL THEN $7::text WHEN $2::text = 'healthy' THEN NULL ELSE last_error END,
              healthy_at = CASE WHEN $2::text = 'healthy' AND healthy_at IS NULL THEN $6 ELSE healthy_at END,
              stopped_at = CASE WHEN $8::boolean THEN $6 ELSE stopped_at END,
              stop_reason = CASE WHEN $8::boolean THEN $9::text ELSE stop_reason END
        WHERE id=$1`,
      [
        r.id,
        state,
        JSON.stringify(msg.services),
        msg.activity ?? null,
        JSON.stringify(sources),
        now,
        msg.error ?? null,
        terminal,
        msg.endReason ?? (state === 'failed' ? 'failed' : 'stopped'),
      ],
    );
    const events: AppendInput[] = [];
    const scope = projectScope(r.org_id, r.project_id);
    const note = (text: string) =>
      r.devops_request_id
        ? events.push(threadMessage(r.devops_request_id, r.org_id, { kind: 'system' }, 'system', text))
        : undefined;
    if (terminal && state === 'failed' && r.purpose === 'test' && msg.rebaseConflictFiles && r.card_id) {
      // The card branch conflicts with its base branch: no environment can run it, the card goes to Rework (like a tester
      // shift whose rebase conflicted).
      const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [r.card_id]);
      if (card && card.status === 'queued' && !card.claim_id) {
        const repo = card.repo_id
          ? await one(tx, 'SELECT working_branch FROM project_repos WHERE id=$1', [card.repo_id])
          : undefined;
        const proj = await one(tx, 'SELECT working_branch FROM projects WHERE id=$1', [card.project_id]);
        events.push(
          ...rebaseConflictEvents(
            card,
            workstationId,
            card.stage,
            (repo?.working_branch ?? proj?.working_branch ?? '') as string,
            msg.rebaseConflictFiles,
          ),
        );
      }
      await exec(tx, 'UPDATE run_environments SET failure_handled=true WHERE id=$1', [r.id]);
    }
    if (terminal) {
      events.push({
        streamId: streamId.run(r.id),
        event: {
          type: 'RunEnvironmentEnded',
          payload: {
            envId: r.id,
            reason: msg.endReason ?? (state === 'failed' ? 'failed' : 'stopped'),
            ...(msg.error ? { detail: msg.error.slice(0, 4000) } : {}),
          },
        },
        actor: runnerActor(workstationId),
        scope,
      });
      note(
        state === 'failed'
          ? `The environment failed${msg.error ? `: ${msg.error}` : '.'}`
          : `The environment stopped (${msg.endReason ?? 'stopped'}).`,
      );
    } else if (state === 'healthy' && r.state !== 'healthy') {
      const urls = msg.services.flatMap((s) => s.urls);
      note(`The environment is running${urls.length ? `: ${urls.join(', ')}` : '.'}`);
    }
    if (events.length) await ctx.store.append(events, { tx });
    return true;
  });
  if (changed) {
    ctx.services.browser.runChanged(msg.envId);
    // A card may be waiting for its test environment (healthy), or need a new one (failed, stopped): look again.
    if (['healthy', 'failed', 'stopped'].includes(msg.state)) ctx.services.dispatcher.trigger();
  }
}

/** `run.plan.saved` from `aom run ready`: the next version of the project's plan on this workstation. */
export async function applyRunPlanSaved(
  ctx: Ctx,
  tx: Tx,
  workstationId: string,
  msg: RunnerToServerOf<'run.plan.saved'>,
): Promise<void> {
  const r = await one(tx, 'SELECT * FROM run_environments WHERE id=$1 AND workstation_id=$2 FOR UPDATE', [
    msg.envId,
    workstationId,
  ]);
  if (!r) return;
  const plan = RunPlanSchema.safeParse(msg.plan);
  if (!plan.success || validateRunPlan(plan.data).length) {
    ctx.log.warn({ envId: msg.envId }, 'run.plan.saved: the plan is invalid, dropped');
    return;
  }
  const project = await one(tx, 'SELECT run_instructions, run_settings FROM projects WHERE id=$1', [
    r.project_id,
  ]);
  const repos = await rows(
    tx,
    'SELECT id, run_instructions FROM project_repos WHERE project_id=$1 ORDER BY id',
    [r.project_id],
  );
  // Fingerprint: BUILD.md (hash from the runner), the run instructions and the structured fields at this moment.
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        msg.buildHash ?? '',
        project?.run_instructions ?? '',
        repos.map((x) => [x.id, x.run_instructions ?? '']),
        project?.run_settings ?? {},
      ]),
    )
    .digest('hex');
  const last = await one(
    tx,
    'SELECT COALESCE(max(version), 0) AS v FROM run_plans WHERE project_id=$1 AND workstation_id=$2',
    [r.project_id, workstationId],
  );
  const version = Number(last?.v ?? 0) + 1;
  const planId = randomUUID();
  await ctx.store.append(
    [
      {
        streamId: streamId.project(r.project_id),
        event: {
          type: 'RunPlanSaved',
          payload: {
            planId,
            projectId: r.project_id,
            workstationId,
            version,
            plan: plan.data,
            fingerprint,
            requestId: r.devops_request_id ?? null,
            envId: r.id,
            ...(msg.buildHash ? { buildHash: msg.buildHash } : { buildHash: '' }),
            settingsHash: await settingsHashOf(tx, r.project_id),
          },
        },
        actor: runnerActor(workstationId),
        scope: projectScope(r.org_id, r.project_id),
      },
    ],
    { tx },
  );
  await exec(tx, 'UPDATE run_environments SET plan_id=$2, plan_version=$3 WHERE id=$1', [
    r.id,
    planId,
    version,
  ]);
}

/** `command.result` of `run.start`: a refusal ends the environment as failed. */
export async function applyRunStartResult(
  ctx: Ctx,
  workstationId: string,
  payload: Record<string, any>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const res = (result ?? {}) as { ok?: boolean; error?: string };
  if (ok && res.ok !== false) return;
  const reason = (res.error ?? error ?? 'the runner could not prepare the environment').slice(0, 2000);
  await applyRunStatus(ctx, workstationId, {
    envId: String(payload.envId),
    state: 'failed',
    services: [],
    error: reason,
    endReason: 'failed',
  });
}

// ---------------------------------------------------------------------------------- scheduler tick

/** TTL expiry, and environments nobody is working on any more. Idempotent; called from the scheduler's main pass. */
export async function expireRuns(ctx: Ctx): Promise<{ stopped: string[] }> {
  const now = ctx.clock.now();
  const stopped: string[] = [];
  const due = await rows(
    ctx.pool,
    `SELECT e.*, w.user_id AS ws_user_id FROM run_environments e JOIN workstations w ON w.id = e.workstation_id
      WHERE e.state NOT IN ('stopped','failed','stopping') AND e.stop_requested_at IS NULL
        AND (
          (e.expires_at IS NOT NULL AND e.expires_at <= $1)
          OR (e.state = 'requested' AND e.created_at <= $2)
          OR (e.state IN ('preparing','starting') AND e.devops_request_id IS NULL AND e.replayed AND e.updated_at <= $4)
          OR (e.state IN ('requested','preparing','starting') AND e.devops_request_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM devops_requests q WHERE q.id = e.devops_request_id AND q.status IN ('done','failed')
                   AND q.updated_at <= $3))
        )`,
    [
      now,
      new Date(now.getTime() - REQUESTED_TIMEOUT_MS),
      new Date(now.getTime() - REQUEST_DONE_GRACE_MS),
      new Date(now.getTime() - REPLAY_TIMEOUT_MS),
    ],
  );
  const wss = new Set<string>();
  for (const r of due) {
    try {
      await withAppendTx(ctx.pool, async (tx) => {
        const cur = await one(tx, 'SELECT * FROM run_environments WHERE id=$1 FOR UPDATE', [r.id]);
        if (!cur || cur.stop_requested_at || !isLiveRunState(cur.state)) return;
        const ttl = cur.expires_at && new Date(cur.expires_at).getTime() <= now.getTime();
        if (ttl) {
          await requestStopIn(ctx, tx, cur, null, 'ttl');
        } else {
          const why =
            cur.state === 'requested'
              ? 'The runner did not pick the environment up in time.'
              : cur.devops_request_id === null
                ? 'The saved plan did not finish starting in time.'
                : 'The DevOps engineer finished without making the environment ready.';
          await requestStopIn(ctx, tx, cur, null, 'failed');
          await exec(tx, 'UPDATE run_environments SET last_error=$2 WHERE id=$1', [cur.id, why]);
        }
        wss.add(cur.workstation_id);
        stopped.push(cur.id);
      });
    } catch (err) {
      ctx.log.warn({ err, envId: r.id }, 'run environment expiry failed');
    }
  }
  deliver(ctx, [...wss]);
  for (const id of stopped) ctx.services.browser.runChanged(id);
  return { stopped };
}

// ------------------------------------------------------------------------------------- DevOps brief

/** The `run` part of the DevOps shift for a request that carries an environment (null: not a run request). */
export async function runBriefFor(ctx: Ctx, req: Row): Promise<DevopsRun | null> {
  const envId = (req.context as { envId?: string; requestKind?: string } | null)?.envId;
  if (!envId || (req.context as { requestKind?: string }).requestKind !== 'run') return null;
  const env = await one(ctx.pool, 'SELECT * FROM run_environments WHERE id=$1', [envId]);
  if (!env) return null;
  const project = await one(
    ctx.pool,
    'SELECT key, name, run_instructions, run_settings FROM projects WHERE id=$1',
    [env.project_id],
  );
  if (!project) return null;
  const repos = await rows(
    ctx.pool,
    'SELECT id, name, run_instructions, project_path, working_branch FROM project_repos WHERE project_id=$1',
    [env.project_id],
  );
  const settings = RunSettingsSchema.parse(project.run_settings ?? {});
  const plan = await one(
    ctx.pool,
    `SELECT plan, status FROM run_plans WHERE project_id=$1 AND workstation_id=$2 AND status <> 'superseded'`,
    [env.project_id, env.workstation_id],
  );
  const sources = (env.sources ?? []) as Array<{ repoId: string; branch: string; commit?: string | null }>;
  return {
    envId,
    purpose: env.purpose,
    projectKey: project.key,
    projectName: project.name,
    sources: sources.map((s) => {
      const repo = repos.find((x) => x.id === s.repoId);
      return {
        repoId: s.repoId,
        name: repo?.name ?? 'repository',
        branch: s.branch,
        ...(repo?.project_path ? { projectPath: repo.project_path } : {}),
        commit: s.commit ?? null,
      };
    }),
    services: env.services ?? [],
    runInstructions: project.run_instructions ?? '',
    repoInstructions: repos
      .filter((r) => sources.some((s) => s.repoId === r.id) && (r.run_instructions ?? '').trim())
      .map((r) => ({ repoId: r.id, name: r.name, text: r.run_instructions })),
    declared: settings.services,
    ...((req.context as { replayFailure?: string } | null)?.replayFailure
      ? { replayFailure: (req.context as { replayFailure: string }).replayFailure }
      : {}),
    currentPlan: plan ? RunPlanSchema.parse(plan.plan) : null,
    planStatus: plan?.status ?? null,
    portRange: { ...DEFAULT_RUN_PORT_RANGE },
    allowDocker: settings.allowDocker,
    ttlAt: iso(env.expires_at),
    buildDocs: [],
  };
}
