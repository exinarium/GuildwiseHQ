import {
  type IntegrationTests,
  type IntegrationTestsResponse,
  IntegrationTestsSchema,
  integrationTestsOn,
  type SetIntegrationTestsRequest,
  streamId,
  type TestSuiteResultDto,
  validateIntegrationTests,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { projectScope, userActor } from './common.ts';

/**
 * The project's integration test setting (backlog #59, docs/design/run-and-integration-tests.md 4.1): mode, suites, how
 * long a failed environment is kept, flaky retries. Same permission as the other Run & test settings (the project owner).
 * Every project starts `off`; the owner switches it on.
 */

/** The setting as stored (a project row's `integration_tests` column); anything unreadable counts as off. */
export function integrationTestsOf(row: Row | null | undefined): IntegrationTests {
  const parsed = IntegrationTestsSchema.safeParse(row?.integration_tests ?? {});
  return parsed.success ? parsed.data : IntegrationTestsSchema.parse({});
}

export async function loadIntegrationTests(db: Queryable, projectId: string): Promise<IntegrationTests> {
  return integrationTestsOf(await one(db, 'SELECT integration_tests FROM projects WHERE id=$1', [projectId]));
}

/** Does a new card of this project run the tester's integration tests (mode is not off)? */
export async function integrationTestsDefault(db: Queryable, projectId: string): Promise<boolean> {
  return integrationTestsOn(await loadIntegrationTests(db, projectId));
}

/**
 * The card's `integrationTests` flag: its own choice, else the project's setting. A card that never had the field (made
 * before the setting existed, or by a path that did not set it) takes the project's setting when it is first asked.
 */
export function cardIntegrationTests(card: Row, projectSettings: IntegrationTests): boolean {
  const own = (card.fields as Record<string, unknown> | null)?.integrationTests;
  return typeof own === 'boolean' ? own : integrationTestsOn(projectSettings);
}

async function workstationCanProvision(db: Queryable, projectId: string): Promise<boolean> {
  const r = await one(
    db,
    `SELECT 1 AS ok FROM workstation_capabilities c
       JOIN workstations w ON w.id = c.workstation_id AND w.status = 'active'
       JOIN project_members pm ON pm.user_id = w.user_id AND pm.project_id = $1 AND pm.status = 'active'
      WHERE 'runs:3' = ANY (c.capabilities) LIMIT 1`,
    [projectId],
  );
  return !!r;
}

export async function getIntegrationTests(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<IntegrationTestsResponse> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const repos = await rows(
    ctx.pool,
    'SELECT id, name FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name, id',
    [projectId],
  );
  return {
    settings: integrationTestsOf(p),
    repos: repos.map((r) => ({ repoId: r.id, name: r.name })),
    targets: await testableTargets(ctx.pool, projectId),
    canProvision: await workstationCanProvision(ctx.pool, projectId),
  };
}

/** Deploy targets of the project (the remote mode needs one the tester may test: opted in, not production). */
export async function testableTargets(
  db: Queryable,
  projectId: string,
): Promise<IntegrationTestsResponse['targets']> {
  const list = await rows(
    db,
    `SELECT id, name, app_url, test_enabled, production FROM deploy_targets
      WHERE project_id=$1 AND removed_at IS NULL AND app_url IS NOT NULL ORDER BY lower(name)`,
    [projectId],
  );
  return list.map((t) => ({
    id: t.id,
    name: t.name,
    url: t.app_url,
    testEnabled: !!t.test_enabled,
    production: !!t.production,
  }));
}

async function projectRepoIds(db: Queryable, projectId: string): Promise<string[]> {
  return (
    await rows<{ id: string }>(
      db,
      'SELECT id FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
      [projectId],
    )
  ).map((r) => r.id);
}

export async function setIntegrationTests(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: SetIntegrationTestsRequest,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const problems = validateIntegrationTests(req.settings, await projectRepoIds(tx, projectId));
    if (req.settings.mode === 'remote' && req.settings.deployTargetId) {
      const t = await one(
        tx,
        `SELECT test_enabled, production FROM deploy_targets WHERE id=$1 AND project_id=$2 AND removed_at IS NULL`,
        [req.settings.deployTargetId, projectId],
      );
      if (!t) problems.push('the deploy target is not part of this project');
      else if (t.production) problems.push('a production target is never tested');
      else if (!t.test_enabled)
        problems.push('testing is switched off for this deploy target (Project settings > Deploy targets)');
    }
    if (problems.length) throw badRequest('invalid_integration_tests', problems.join('; '));
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectIntegrationTestsSet',
            payload: { projectId, settings: req.settings, by: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
  // A card waiting for its environment may be provisionable now (the mode changed).
  ctx.services.dispatcher.trigger();
}

/** Confirms (or un-confirms) a suite a tester proposed. */
export async function confirmSuite(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  name: string,
  confirmed: boolean,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const settings = integrationTestsOf(p);
    const hit = settings.suites.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!hit) throw notFound('suite not found');
    const next = {
      ...settings,
      suites: settings.suites.map((s) => (s === hit ? { ...s, confirmed } : s)),
    };
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectIntegrationTestsSet', payload: { projectId, settings: next, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

// ------------------------------------------------------------------------------------------ card view

export function toSuiteResultDto(r: Row): TestSuiteResultDto {
  return {
    id: r.id,
    suite: r.suite,
    kind: r.kind ?? null,
    envMode: r.env_mode ?? null,
    targetName: r.target_name ?? null,
    commit: r.commit ?? null,
    status: r.status,
    passed: r.passed,
    failed: r.failed,
    skipped: r.skipped,
    durationMs: r.duration_ms,
    attempts: r.attempts,
    failures: (r.failures ?? []) as string[],
    attachmentId: r.attachment_id ?? null,
    note: r.note ?? null,
    createdAt: iso(r.created_at) as string,
  };
}

/** The suite results of a card, oldest first. */
export async function suiteResultsOf(db: Queryable, cardId: string): Promise<TestSuiteResultDto[]> {
  const list = await rows(
    db,
    `SELECT r.*, t.name AS target_name FROM test_suite_results r
       LEFT JOIN deploy_targets t ON t.id = r.deploy_target_id
      WHERE r.card_id=$1 ORDER BY r.created_at, r.event_seq`,
    [cardId],
  );
  return list.map(toSuiteResultDto);
}
