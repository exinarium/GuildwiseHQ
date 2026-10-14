import { randomUUID } from 'node:crypto';
import {
  branchName,
  DEFAULT_RUN_PORT_RANGE,
  DESK_SUBKIND,
  FLAKY_NOTICE_COUNT,
  FLAKY_WINDOW_DAYS,
  getStage,
  IntegrationSuiteSchema,
  type IntegrationTests,
  isLiveRunState,
  type RunnerToServerOf,
  type RunStartPayload,
  resolveOutcome,
  type ShiftEnvironment,
  streamId,
  suitesWithoutPass,
  type TestEnvProblem,
  type TestSuiteReport,
  TestSuiteReportSchema,
  type WorkflowCardView,
  workflowHasIntegrationGuard,
} from '@aom/shared';
import { resolveWorkflow, type WorkflowVersionRow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { workflowView } from './cards.ts';
import { loadCommitAs } from './commit-as.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR } from './common.ts';
import { createDevOpsRequestIn } from './devops.ts';
import { cardIntegrationTests, integrationTestsOf } from './integration-tests.ts';
import { branchKey, capsOf, findReplay, requestStopIn } from './runs.ts';
import { PROBLEM_TEXT, testEnvironmentHardStop } from './testing.ts';
import { deliver } from './workstation-setup.ts';

/**
 * Test environments for the tester's integration tests (backlog #59, docs/design/run-and-integration-tests.md D9, 4.3).
 * For a card queued at a stage with `environment: 'project'` (code v4's `test`), when the project runs its tests locally,
 * the dispatcher asks the card's workstation to start the card's commit (`run.start` with `rebaseCard`) and the candidate
 * query keeps the card back until the environment is healthy there. The server stops the environment at the verdict (kept
 * `keepOnFailureMin` after a failure). A plan that is missing or fails goes through the DevOps engineer, as for a manual start.
 */

/** A test environment nobody uses is stopped after this long (a safety net: the verdict normally ends it first). */
const TEST_ENV_TTL_MS = 4 * 3600_000;
/** A card whose test environment failed this many times needs a person. */
const MAX_ENV_ATTEMPTS = 2;

const LIVE = `e.state NOT IN ('stopped','failed')`;

// ----------------------------------------------------------------------------------------- lookups

/** The test environment of a card that is live and has not reached its verdict (the one a tester uses). */
export async function currentTestEnv(db: Queryable, cardId: string): Promise<Row | undefined> {
  return one(
    db,
    `SELECT e.* FROM run_environments e
      WHERE e.card_id=$1 AND e.purpose='test' AND e.verdict_at IS NULL AND ${LIVE}
      ORDER BY e.created_at DESC LIMIT 1`,
    [cardId],
  );
}

export async function stageEnvironmentOf(db: Queryable, card: Row): Promise<'none' | 'project'> {
  const st = await one(
    db,
    'SELECT environment FROM workflow_stages WHERE workflow_version_id=$1 AND stage_id=$2',
    [card.workflow_version_id, card.stage],
  );
  return st?.environment === 'project' ? 'project' : 'none';
}

/** The deployed target a tester tests in remote mode (opted in, not production), or nothing when the setting is not usable. */
async function remoteEnvironment(
  db: Queryable,
  projectId: string,
  settings: IntegrationTests,
): Promise<ShiftEnvironment | undefined> {
  if (!settings.deployTargetId) return undefined;
  const t = await one(
    db,
    `SELECT * FROM deploy_targets WHERE id=$1 AND removed_at IS NULL AND test_enabled AND NOT production AND app_url IS NOT NULL`,
    [settings.deployTargetId],
  );
  if (!t || t.project_id !== projectId) return undefined;
  return {
    mode: 'remote',
    suites: settings.suites,
    flakyRetry: settings.flakyRetry,
    target: {
      id: t.id,
      name: t.name,
      url: t.app_url,
      hosts: (t.test_hosts ?? []) as string[],
      destructiveOk: !!t.destructive_ok,
      secretNames: (t.secret_names ?? []) as string[],
    },
  };
}

/**
 * What a tester shift on this card tests against, or nothing: a local environment of the card (healthy, on the shift's
 * workstation) when the project runs its tests locally. The runner adds the live ports and URLs from its own record.
 */
export async function shiftEnvironmentFor(
  db: Queryable,
  card: Row,
  workstationId: string,
): Promise<ShiftEnvironment | undefined> {
  if ((await stageEnvironmentOf(db, card)) !== 'project') return undefined;
  const project = await one(db, 'SELECT integration_tests FROM projects WHERE id=$1', [card.project_id]);
  const settings = integrationTestsOf(project);
  if (settings.mode === 'off' || (card.fields as Record<string, unknown> | null)?.integrationTests === false)
    return undefined;
  if (settings.mode === 'remote') return remoteEnvironment(db, card.project_id, settings);
  const env = await one(
    db,
    `SELECT e.id FROM run_environments e
      WHERE e.card_id=$1 AND e.purpose='test' AND e.verdict_at IS NULL AND e.state='healthy' AND e.workstation_id=$2
      ORDER BY e.created_at DESC LIMIT 1`,
    [card.id, workstationId],
  );
  if (!env) return undefined;
  return { mode: 'local', envId: env.id, suites: settings.suites, flakyRetry: settings.flakyRetry };
}

// --------------------------------------------------------------------------------------- provisioning

interface Provision {
  card: Row;
  project: Row;
  settings: IntegrationTests;
  /** The role that works the stage (an agent of it must be hired on the workstation): the tester for `test`. */
  role?: string;
}

/** Why a card could not be provisioned right now (it waits and is tried again on the next pass). */
type Skip = { skip: string };

/**
 * Starts a test environment for the card on its workstation: the environment row, the `run.start` command (with the
 * card rebase) and, when no saved plan can be replayed, a DevOps `run` request. Returns the environment id or why not.
 * `forceDevops`: file the DevOps request even if a plan exists (a plan that just failed).
 */
export async function startTestRunIn(
  ctx: Ctx,
  tx: Tx,
  p: Provision,
  opts: { forceDevops?: boolean; failure?: string } = {},
): Promise<{ envId: string; requestId: string | null; wsId: string } | Skip> {
  const { card, project, settings } = p;
  const role = p.role ?? 'tester';
  const now = ctx.clock.now();
  const wsId = card.home_workstation_id as string | null;
  if (!wsId) return { skip: 'the card has no workstation yet' };
  const ws = await one(
    tx,
    `SELECT w.id, w.name, w.connected, w.last_seen_at FROM workstations w
       JOIN users u ON u.id = w.user_id AND u.status = 'active'
      WHERE w.id=$1 AND w.status='active'`,
    [wsId],
  );
  if (!ws?.connected) return { skip: 'its workstation is offline' };
  const caps = await capsOf(tx, ws.id);
  if (!caps.testEnv) return { skip: 'the runner on its workstation cannot start test environments' };
  const live = await one(
    tx,
    `SELECT count(*)::int AS n FROM run_environments e WHERE e.workstation_id=$1 AND ${LIVE}`,
    [ws.id],
  );
  if (Number(live?.n) >= caps.max) return { skip: 'the workstation runs its maximum number of environments' };
  // A tester must be there to use it.
  const tester = await one(
    tx,
    `SELECT 1 AS ok FROM agents a
      WHERE a.workstation_id=$1 AND a.status='active' AND NOT a.is_devops AND a.role_key=$3
        AND (a.allowed_project_ids IS NULL OR $2::uuid = ANY (a.allowed_project_ids)) LIMIT 1`,
    [ws.id, project.id, role],
  );
  if (!tester) return { skip: `no ${role} is hired on its workstation` };

  const repos = await rows(
    tx,
    `SELECT pr.id, pr.name, pr.remote_url_normalized, pr.working_branch, pr.project_path
       FROM project_repos pr JOIN workstation_repos wr ON wr.project_repo_id = pr.id AND wr.workstation_id = $2
      WHERE pr.project_id=$1 AND pr.removed_at IS NULL ORDER BY pr.name, pr.id`,
    [project.id, ws.id],
  );
  const wcard = card.worktree_card_id
    ? ((await one(tx, 'SELECT * FROM cards WHERE id=$1', [card.worktree_card_id])) as Row)
    : card;
  const cardRepo = repos.find((r) => r.id === card.repo_id);
  if (!cardRepo) return { skip: 'the card repository is not cloned on its workstation' };
  if (!wcard.worktree_path) return { skip: 'the card has no worktree yet' };
  const cardBranch = (wcard.branch_name ??
    branchName(project.branch_prefix, wcard.ref, wcard.title)) as string;
  const sources = repos.map((r) => ({
    repo: r,
    branch: (r.id === cardRepo.id ? cardBranch : (r.working_branch ?? project.working_branch)) as string,
  }));
  const wanted = settings.services;
  const sourcesJson = sources.map((s) => ({ repoId: s.repo.id, branch: s.branch, commit: null }));
  const key = branchKey(sources.map((s) => ({ repoId: s.repo.id, branch: s.branch })));

  const { replay, planRow } = opts.forceDevops
    ? {}
    : await findReplay(
        ctx,
        tx,
        project.id,
        ws.id,
        caps.replay,
        sources.map((s) => s.repo.id),
        wanted,
      );
  if (!replay) {
    const agent = await one(
      tx,
      `SELECT 1 AS ok FROM agents WHERE workstation_id=$1 AND is_devops AND status='active' LIMIT 1`,
      [ws.id],
    );
    if (!agent) return { skip: 'there is no run plan and no DevOps engineer on its workstation to make one' };
  }

  const envId = randomUUID();
  const expiresAt = new Date(now.getTime() + TEST_ENV_TTL_MS);
  await exec(
    tx,
    `INSERT INTO run_environments (id, org_id, project_id, workstation_id, purpose, card_id, sources, services, state,
        requested_by, branch_key, created_at, updated_at, expires_at, replayed, plan_id, plan_version)
     VALUES ($1,$2,$3,$4,'test',$5,$6::jsonb,$7::text[],'requested',NULL,$8,$9,$9,$10,$11,$12,$13)`,
    [
      envId,
      project.org_id,
      project.id,
      ws.id,
      card.id,
      JSON.stringify(sourcesJson),
      wanted,
      key,
      now,
      expiresAt,
      !!replay,
      planRow?.id ?? null,
      planRow?.version ?? null,
    ],
  );
  let requestId: string | null = null;
  if (!replay) {
    const summary = `Make ${project.name} run so the integration tests of ${card.ref} can start: ${sources
      .map((s) => `${s.repo.name}@${s.branch}`)
      .join(', ')}. ${
      opts.failure
        ? `The saved plan failed: ${opts.failure.slice(0, 300)}.`
        : 'There is no saved run plan yet.'
    }`;
    requestId = (
      await createDevOpsRequestIn(ctx, tx, {
        workstationId: ws.id,
        orgId: project.org_id,
        summary,
        requestedBy: { kind: 'system', id: null, name: 'Integration tests' },
        cardId: card.id,
        origin: 'card',
        context: {
          projectId: project.id,
          workstationId: ws.id,
          cardId: card.id,
          requestKind: 'run',
          envId,
          ...(opts.failure ? { replayFailure: opts.failure.slice(0, 12000) } : {}),
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
            purpose: 'test',
            cardId: card.id,
            sources: sourcesJson,
            services: wanted,
            requestedBy: null,
            requestId,
            expiresAt: expiresAt.toISOString(),
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(project.org_id, project.id),
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        replay
          ? `Starting the test environment for ${card.ref} from the saved run plan.`
          : `Starting the test environment for ${card.ref}: ${
              opts.failure ? 'the saved run plan failed' : 'there is no run plan yet'
            }, so the DevOps engineer is working out how to run the project first.`,
        { envId },
      ),
    ],
    { tx },
  );
  const commitAs = await loadCommitAs(tx, project.id);
  const runSettings = (project.run_settings ?? {}) as { allowDocker?: boolean };
  const payload: RunStartPayload = {
    envId,
    projectId: project.id,
    projectKey: project.key,
    projectName: project.name,
    purpose: 'test',
    requestId,
    sources: sources.map((s) => ({
      repoId: s.repo.id,
      name: s.repo.name,
      remoteUrlNormalized: s.repo.remote_url_normalized,
      branch: s.branch,
      ...(s.repo.project_path ? { projectPath: s.repo.project_path } : {}),
    })),
    services: wanted,
    portRange: { ...DEFAULT_RUN_PORT_RANGE },
    ttlAt: expiresAt.toISOString(),
    allowDocker: runSettings.allowDocker === true,
    rebaseCard: {
      repoId: cardRepo.id,
      cardWorktreePath: wcard.worktree_path,
      baseBranch: (cardRepo.working_branch ?? project.working_branch) as string,
      ...(commitAs ? { commitAs } : {}),
    },
    ...(replay ? { replay } : {}),
  };
  await enqueueRunnerCommand(tx, ws.id, 'run.start', payload);
  return { envId, requestId, wsId: ws.id };
}

/** One dispatcher pass: failed environments are dealt with, finished ones stopped, and cards that wait get theirs. */
export async function testEnvironmentPass(ctx: Ctx): Promise<void> {
  try {
    await sweepTestEnvironments(ctx);
    await handleFailedEnvironments(ctx);
    await provisionPass(ctx);
  } catch (err) {
    ctx.log.error({ err }, 'test environment pass failed');
  }
}

const NEEDS_ENV_SQL = `
SELECT c.id, st.claim_role AS role FROM cards c
  JOIN projects p ON p.id = c.project_id AND p.status = 'active' AND p.integration_tests->>'mode' = 'local'
  JOIN workflow_stages st ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = c.stage
 WHERE st.kind = 'agent' AND st.environment = 'project' AND st.claim_role IS NOT NULL
   AND c.status = 'queued' AND c.claim_id IS NULL
   AND c.origin NOT IN ('full_suite', 'regression')
   AND COALESCE((c.fields->>'integrationTests')::boolean, true) = true
   AND c.repo_id IS NOT NULL AND c.home_workstation_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM run_environments e
                    WHERE e.card_id = c.id AND e.purpose = 'test' AND e.verdict_at IS NULL AND ${LIVE})
 ORDER BY c.queued_at NULLS LAST, c.created_at
 LIMIT 20`;

async function provisionPass(ctx: Ctx): Promise<void> {
  const due = await rows<{ id: string; role: string }>(ctx.pool, NEEDS_ENV_SQL);
  const wss = new Set<string>();
  for (const { id, role } of due) {
    try {
      const ws = await withAppendTx(ctx.pool, async (tx) => {
        const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [id]);
        if (!card || card.status !== 'queued' || card.claim_id) return null;
        if (await currentTestEnv(tx, id)) return null;
        const project = (await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Row;
        const r = await startTestRunIn(ctx, tx, {
          card,
          project,
          settings: integrationTestsOf(project),
          role,
        });
        return 'skip' in r ? null : r.wsId;
      });
      if (ws) wss.add(ws);
    } catch (err) {
      ctx.log.warn({ err, cardId: id }, 'could not start a test environment');
    }
  }
  if (wss.size) deliver(ctx, [...wss]);
}

/**
 * A test environment that failed (its plan did not work and the DevOps engineer could not repair it, or the runner
 * refused it): the card waits for that DevOps request and then tries again; a second failure needs a person.
 */
async function handleFailedEnvironments(ctx: Ctx): Promise<void> {
  const failed = await rows<{ id: string }>(
    ctx.pool,
    `SELECT e.id FROM run_environments e WHERE e.purpose='test' AND e.state='failed' AND NOT e.failure_handled
      ORDER BY e.updated_at LIMIT 20`,
  );
  for (const { id } of failed) {
    try {
      await withAppendTx(ctx.pool, async (tx) => {
        const env = await one(tx, 'SELECT * FROM run_environments WHERE id=$1 FOR UPDATE', [id]);
        if (!env || env.failure_handled) return;
        await exec(tx, 'UPDATE run_environments SET failure_handled=true WHERE id=$1', [id]);
        const card = env.card_id
          ? await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [env.card_id])
          : null;
        // Nothing waits for it any more: the card moved on, was cancelled, or got another environment.
        if (!card || card.status !== 'queued' || card.claim_id) return;
        if ((await stageEnvironmentOf(tx, card)) !== 'project') return;
        const reason = (env.last_error as string | null) ?? 'it did not come up';
        const events: AppendInput[] = [];
        const attempts = Number(card.env_parks);
        if (attempts >= MAX_ENV_ATTEMPTS || !env.devops_request_id) {
          events.push(
            ...testEnvironmentHardStop(
              card,
              'run_failed',
              reason.slice(0, 300),
              attempts >= MAX_ENV_ATTEMPTS
                ? 'The DevOps engineer already tried to make the project run twice.'
                : 'It failed before the DevOps engineer could look at it.',
            ),
          );
        } else {
          events.push(
            {
              streamId: streamId.card(card.id),
              event: {
                type: 'TestEnvironmentParked',
                payload: {
                  cardId: card.id,
                  requestId: env.devops_request_id,
                  problem: 'run_failed',
                  detail: reason.slice(0, 300),
                },
              },
              actor: SYSTEM_ACTOR,
              scope: projectScope(card.org_id, card.project_id),
            },
            cardMessage(
              card,
              { kind: 'system' },
              'system',
              `The test environment for ${card.ref} did not come up (${reason.slice(0, 300)}). The card waits for the DevOps engineer's request to finish and then tries again.`,
              { envId: env.id },
            ),
          );
        }
        await ctx.store.append(events, { tx });
      });
    } catch (err) {
      ctx.log.warn({ err, envId: id }, 'could not deal with a failed test environment');
    }
  }
}

/** Test environments whose card is done, cancelled or no longer at an environment stage are stopped. */
async function sweepTestEnvironments(ctx: Ctx): Promise<void> {
  const stale = await rows<{ id: string }>(
    ctx.pool,
    `SELECT e.id FROM run_environments e
       JOIN cards c ON c.id = e.card_id
       LEFT JOIN workflow_stages st ON st.workflow_version_id = c.workflow_version_id AND st.stage_id = c.stage
      WHERE e.purpose = 'test' AND ${LIVE} AND e.state <> 'stopping' AND e.stop_requested_at IS NULL
        AND (c.status IN ('done','cancelled') OR st.environment IS DISTINCT FROM 'project')`,
  );
  const wss = new Set<string>();
  for (const { id } of stale) {
    try {
      await withAppendTx(ctx.pool, async (tx) => {
        const env = await one(tx, 'SELECT * FROM run_environments WHERE id=$1 FOR UPDATE', [id]);
        if (!env || env.stop_requested_at || !isLiveRunState(env.state) || env.state === 'stopping') return;
        await requestStopIn(ctx, tx, env, null, 'verdict');
        wss.add(env.workstation_id);
      });
    } catch (err) {
      ctx.log.warn({ err, envId: id }, 'could not stop a finished test environment');
    }
  }
  if (wss.size) deliver(ctx, [...wss]);
}

// ----------------------------------------------------------------------------------------------- verdict

/**
 * The tester's verdict (or any outcome of an environment stage) was recorded: the environment is stopped, except after a
 * failure where it is kept `keepOnFailureMin` for inspection. Call inside the transaction that appends the outcome.
 * Returns the workstation to nudge.
 */
export async function endTestEnvironmentIn(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  failed: boolean,
): Promise<string | null> {
  const env = await currentTestEnv(tx, card.id);
  if (!env) return null;
  const now = ctx.clock.now();
  const project = await one(tx, 'SELECT integration_tests FROM projects WHERE id=$1', [card.project_id]);
  const keepMin = integrationTestsOf(project).keepOnFailureMin;
  if (failed && keepMin > 0 && env.state === 'healthy') {
    await exec(tx, 'UPDATE run_environments SET verdict_at=$2, expires_at=$3, updated_at=$2 WHERE id=$1', [
      env.id,
      now,
      new Date(now.getTime() + keepMin * 60_000),
    ]);
    return null;
  }
  await exec(tx, 'UPDATE run_environments SET verdict_at=$2 WHERE id=$1', [env.id, now]);
  await requestStopIn(ctx, tx, env, null, 'verdict');
  return env.workstation_id as string;
}

// ---------------------------------------------------------------------- rejected: environment not ready

/**
 * A tester shift found no healthy environment (`environment_not_ready` with a run problem): the environment is over, and
 * the DevOps engineer is asked to get the project running (a new environment with a forced request); the card is parked
 * until that request finishes. A second time needs a person.
 */
export async function runProblemEvents(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  env: NonNullable<RunnerToServerOf<'shift.rejected'>['environment']>,
): Promise<AppendInput[]> {
  const problem = env.problem as TestEnvProblem;
  const detail = env.detail ?? '';
  // A deployed target that does not answer is nobody's to start: the owner fixes it, then resolves the item.
  const settings = integrationTestsOf(
    await one(tx, 'SELECT integration_tests FROM projects WHERE id=$1', [card.project_id]),
  );
  if (problem === 'target_unreachable' || settings.mode === 'remote')
    return testEnvironmentHardStop(
      card,
      problem,
      detail,
      'Check that the deployed target answers from the workstation of the tester, then resolve this item and the card returns to the Test queue.',
    );
  // The environment the runner could not use is over.
  const stale = await rows(
    tx,
    `SELECT e.* FROM run_environments e WHERE e.card_id=$1 AND e.purpose='test' AND e.verdict_at IS NULL AND ${LIVE} FOR UPDATE`,
    [card.id],
  );
  for (const e of stale) {
    await exec(tx, 'UPDATE run_environments SET failure_handled=true WHERE id=$1', [e.id]);
    if (!e.stop_requested_at) await requestStopIn(ctx, tx, e, null, 'failed');
  }
  if (Number(card.env_parks) >= MAX_ENV_ATTEMPTS)
    return testEnvironmentHardStop(
      card,
      problem,
      detail,
      'The DevOps engineer already tried to make the project run twice.',
    );
  const project = (await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Row;
  const stageRole = await one(
    tx,
    'SELECT claim_role FROM workflow_stages WHERE workflow_version_id=$1 AND stage_id=$2',
    [card.workflow_version_id, card.stage],
  );
  const started = await startTestRunIn(
    ctx,
    tx,
    {
      card,
      project,
      settings: integrationTestsOf(project),
      ...(stageRole?.claim_role ? { role: stageRole.claim_role as string } : {}),
    },
    { forceDevops: true, failure: detail || PROBLEM_TEXT[problem] },
  );
  if ('skip' in started || !started.requestId)
    return testEnvironmentHardStop(
      card,
      problem,
      detail,
      'skip' in started
        ? `It could not be started again: ${started.skip}.`
        : 'The DevOps engineer could not be asked.',
    );
  deliver(ctx, [started.wsId]);
  return [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'TestEnvironmentParked',
        payload: { cardId: card.id, requestId: started.requestId, problem, detail },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `${PROBLEM_TEXT[problem]}${detail ? ` (${detail})` : ''}. The DevOps engineer was asked to get the project running; ${card.ref} is parked until the request completes.`,
      { requestId: started.requestId, problem },
    ),
  ];
}

// ----------------------------------------------------------------------------------- suite results

/** Normalises a report: a pass after an earlier failure of the same suite in this shift is `flaky`; counts attempts. */
export function normaliseSuiteReport(
  report: TestSuiteReport,
  earlier: ReadonlyArray<{ status: string }>,
): TestSuiteReport {
  const hadFailure = earlier.some((r) => r.status === 'failed' || r.status === 'timeout');
  let status = report.status;
  if (status === 'flaky' && !hadFailure) status = 'passed';
  if (status === 'passed' && hadFailure) status = 'flaky';
  return { ...report, status, attempts: earlier.length + 1 };
}

/** `aom test suite`: the runner parsed the report; the server records it for the shift's card. */
export async function recordSuiteResult(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<[boolean, unknown?, string?]> {
  const parsed = TestSuiteReportSchema.safeParse(params);
  if (!parsed.success)
    return [
      false,
      undefined,
      `invalid suite report: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    ];
  if (shift.kind !== 'card' || !shift.card_id)
    return [false, undefined, '`aom test suite` is for a tester shift on a card'];
  return withAppendTx(ctx.pool, async (tx): Promise<[boolean, unknown?, string?]> => {
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [shift.card_id]);
    if (!card || card.claim_shift_id !== shift.id)
      return [false, undefined, 'this shift no longer holds the claim on the card'];
    const agent = await one(tx, 'SELECT role_key FROM agents WHERE id=$1', [shift.agent_id]);
    if (agent?.role_key !== 'tester') return [false, undefined, 'only a tester reports suites'];
    const project = (await one(tx, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Row;
    const settings = integrationTestsOf(project);
    const configured = settings.suites.find((s) => s.name.toLowerCase() === parsed.data.name.toLowerCase());
    const earlier = await rows<{ status: string }>(
      tx,
      `SELECT status FROM test_suite_results WHERE shift_id=$1 AND lower(suite)=lower($2) ORDER BY created_at, event_seq`,
      [shift.id, parsed.data.name],
    );
    const report = normaliseSuiteReport(parsed.data, earlier);
    const env = await one(
      tx,
      `SELECT e.id FROM run_environments e WHERE e.card_id=$1 AND e.purpose='test' AND ${LIVE} ORDER BY e.created_at DESC LIMIT 1`,
      [card.id],
    );
    const remote =
      settings.mode === 'remote' ? await remoteEnvironment(tx, card.project_id, settings) : undefined;
    if (
      remote?.target &&
      configured?.destructive &&
      !remote.target.destructiveOk &&
      report.status !== 'skipped'
    )
      return [
        false,
        undefined,
        `suite "${configured.name}" writes or deletes data and ${remote.target.name} does not allow that: do not run it; report it with --status skipped`,
      ];
    const attachment = report.attachmentName
      ? await one(
          tx,
          `SELECT id FROM card_attachments WHERE card_id=$1 AND name=$2 ORDER BY created_at DESC LIMIT 1`,
          [card.id, report.attachmentName],
        )
      : undefined;
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'TestSuiteReported',
            payload: {
              cardId: card.id,
              shiftId: shift.id,
              testerAgentId: shift.agent_id,
              suite: configured?.name ?? report.name,
              kind: configured?.kind ?? null,
              envMode: remote?.target ? 'remote' : env ? 'local' : null,
              envId: remote?.target ? null : (env?.id ?? null),
              deployTargetId: remote?.target?.id ?? null,
              commit: report.commit ?? null,
              status: report.status,
              passed: report.passed,
              failed: report.failed,
              skipped: report.skipped,
              durationMs: report.durationMs,
              attempts: report.attempts,
              failures: report.failures,
              attachmentId: attachment?.id ?? report.attachmentId ?? null,
              note: report.note ?? null,
            },
          },
          actor: { kind: 'agent', id: shift.agent_id },
          scope: projectScope(card.org_id, card.project_id),
        },
      ],
      { tx },
    );
    if (report.status === 'flaky')
      await flakyNotice(ctx, tx, card, configured?.name ?? report.name).catch((err) =>
        ctx.log.warn({ err }, 'could not raise the flaky suite notice'),
      );
    const retriesLeft = settings.flakyRetry - earlier.length;
    const message =
      report.status === 'flaky'
        ? `Recorded as flaky (failed, then passed on attempt ${report.attempts}).`
        : report.status === 'failed' || report.status === 'timeout'
          ? retriesLeft > 0
            ? `Recorded as ${report.status}. Run suite "${report.name}" once more and report that run too: a pass after a failure counts as flaky.`
            : `Recorded as ${report.status}. Report the bug with \`aom test fail\` unless the failure is in your own tests.`
          : `Recorded as ${report.status}.`;
    return [true, { status: report.status, attempts: report.attempts, message }];
  });
}

/** A suite that was flaky three times in seven days: one desk notice per project and suite until it is acknowledged. */
async function flakyNotice(ctx: Ctx, tx: Tx, card: Row, suite: string): Promise<void> {
  const since = new Date(ctx.clock.now().getTime() - FLAKY_WINDOW_DAYS * 86_400_000);
  const n = await one(
    tx,
    `SELECT count(*)::int AS n FROM test_suite_results WHERE project_id=$1 AND lower(suite)=lower($2) AND status='flaky' AND created_at >= $3`,
    [card.project_id, suite, since],
  );
  if (Number(n?.n) < FLAKY_NOTICE_COUNT) return;
  const title = `Suite "${suite}" is flaky`;
  const open = await one(
    tx,
    `SELECT 1 AS x FROM desk_items WHERE project_id=$1 AND subkind=$2 AND title=$3 AND status='open'`,
    [card.project_id, DESK_SUBKIND.flakySuite, title],
  );
  if (open) return;
  const deskItemId = randomUUID();
  await ctx.store.append(
    [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'alert',
            subkind: DESK_SUBKIND.flakySuite,
            title,
            body: `The tester's runs of "${suite}" failed and then passed on a retry ${n?.n} times in the last ${FLAKY_WINDOW_DAYS} days. Cards still pass, but a test that cannot be trusted wastes time: look at it, or at the environment it runs in.`,
            options: [],
            blocking: false,
            pinned: false,
            projectId: card.project_id,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(card.org_id, card.project_id),
      },
    ],
    { tx },
  );
}

/** The suites a `aom test pass` still waits for in this shift (empty: it may pass). */
export async function openSuitesOf(db: Queryable, card: Row, shift: Row): Promise<string[]> {
  if ((await stageEnvironmentOf(db, card)) !== 'project') return [];
  const project = await one(db, 'SELECT integration_tests FROM projects WHERE id=$1', [card.project_id]);
  const settings = integrationTestsOf(project);
  const results = await rows(
    db,
    `SELECT suite, status FROM test_suite_results WHERE shift_id=$1 ORDER BY created_at, event_seq`,
    [shift.id],
  );
  const remote =
    settings.mode === 'remote' ? await remoteEnvironment(db, card.project_id, settings) : undefined;
  let suites = settings.suites;
  if (remote?.target) {
    // Against a target that does not allow tests that change data, the destructive suites are skipped, not required.
    if (!remote.target.destructiveOk) suites = suites.filter((x) => !x.destructive);
  } else if (!(await currentTestEnv(db, card.id)) && results.length === 0) {
    // The shift tested against an environment when it is up, or when the tester already reported suites from it.
    return [];
  }
  return suitesWithoutPass(
    suites,
    results.map((r) => ({ suite: r.suite, status: r.status })),
  );
}

/** `aom env suites propose`: suites the tester found; they wait unconfirmed in the project settings. */
export async function proposeSuites(
  ctx: Ctx,
  shift: Row,
  params: Record<string, unknown>,
): Promise<[boolean, unknown?, string?]> {
  const list = Array.isArray(params.suites) ? params.suites : [];
  if (list.length === 0) return [false, undefined, 'no suites to propose'];
  if (!shift.card_id) return [false, undefined, 'this shift has no card'];
  return withAppendTx(ctx.pool, async (tx): Promise<[boolean, unknown?, string?]> => {
    const card = await one(tx, 'SELECT * FROM cards WHERE id=$1', [shift.card_id]);
    if (!card) return [false, undefined, 'card not found'];
    const repos = await rows<{ id: string; name: string }>(
      tx,
      'SELECT id, name FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
      [card.project_id],
    );
    const repoIds = repos.map((r) => r.id);
    // A suite names its repository by name (default: the card's).
    const parsed = list.map((s) => {
      const given = (s as { repo?: string; repoId?: string }).repo ?? (s as { repoId?: string }).repoId;
      const repoId =
        repos.find((r) => r.id === given || r.name.toLowerCase() === String(given ?? '').toLowerCase())?.id ??
        card.repo_id;
      return IntegrationSuiteSchema.safeParse({ ...(s as object), repoId, confirmed: false });
    });
    const bad = parsed.find((r) => !r.success);
    if (bad && !bad.success) return [false, undefined, `invalid suite: ${bad.error.issues[0]?.message}`];
    const ok = parsed.flatMap((r) => (r.success ? [r.data] : []));
    const valid = ok.filter((s) => repoIds.includes(s.repoId));
    if (valid.length === 0) return [false, undefined, 'the suites name no repository of this project'];
    await ctx.store.append(
      [
        {
          streamId: streamId.project(card.project_id),
          event: {
            type: 'IntegrationSuitesProposed',
            payload: { projectId: card.project_id, cardId: card.id, suites: valid },
          },
          actor: { kind: 'agent', id: shift.agent_id },
          scope: projectScope(card.org_id, card.project_id),
        },
      ],
      { tx },
    );
    return [
      true,
      {
        proposed: valid.map((s) => s.name),
        message: 'Proposed. The project owner confirms suites in the project settings.',
      },
    ];
  });
}

/** `aom env suites`: the project's suites for the tester (confirmed ones are required, the rest proposals). */
export async function suitesFor(db: Queryable, shift: Row): Promise<[boolean, unknown?, string?]> {
  if (!shift.card_id) return [false, undefined, 'this shift has no card'];
  const card = await one(db, 'SELECT project_id FROM cards WHERE id=$1', [shift.card_id]);
  if (!card) return [false, undefined, 'card not found'];
  const project = await one(db, 'SELECT integration_tests FROM projects WHERE id=$1', [card.project_id]);
  const s = integrationTestsOf(project);
  return [true, { mode: s.mode, flakyRetry: s.flakyRetry, suites: s.suites }];
}

// --------------------------------------------------------------------- leaving Review: the test guard

export interface ReviewApprovedPlan {
  toStage: string;
  /** The card moves to this (newer) built-in `code` version. */
  workflowVersionId?: string;
  /** The card's own flag, recorded because it was not set (or the card changes version). */
  integrationTests?: boolean;
}

/**
 * Where an approved card goes next when the integration test guard applies (docs/design/run-and-integration-tests.md D8).
 * A card on `code` v1 to v3 moves to the newest built-in version as it leaves Review (the same stages up to Test; it
 * gets the guard and the environment) and a card whose `integrationTests` was never set takes the project's setting
 * now. A card already in Test or beyond is never touched. Null: nothing changes.
 */
export async function reviewApprovedPlan(
  tx: Queryable,
  card: Row,
  wf: WorkflowVersionRow,
  outcomeId: string,
): Promise<ReviewApprovedPlan | null> {
  let def = wf.definition;
  let upgraded: string | undefined;
  const test = getStage(def, 'test');
  if (def.builtIn && def.key === 'code' && test && test.environment !== 'project') {
    const latest = await resolveWorkflow(tx, card.org_id, 'code', card.project_id);
    if (
      latest &&
      latest.orgId === null &&
      latest.version > wf.version &&
      getStage(latest.definition, 'test')?.environment === 'project'
    ) {
      def = latest.definition;
      upgraded = latest.id;
    }
  }
  if (!workflowHasIntegrationGuard(def)) return null;
  const own = (card.fields as Record<string, unknown> | null)?.integrationTests;
  if (!upgraded && typeof own === 'boolean') return null; // set already: the plain resolution is right
  const project = await one(tx, 'SELECT integration_tests FROM projects WHERE id=$1', [card.project_id]);
  const flag = cardIntegrationTests(card, integrationTestsOf(project));
  const view: WorkflowCardView = {
    ...workflowView(card),
    fields: { ...((card.fields as Record<string, unknown> | null) ?? {}), integrationTests: flag },
  };
  return {
    toStage: resolveOutcome(def, view, 'review', outcomeId).toStage,
    ...(upgraded ? { workflowVersionId: upgraded } : {}),
    integrationTests: flag,
  };
}
