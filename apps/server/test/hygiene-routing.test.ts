import { WORKING_BRANCH_SUBKIND } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await w.hire('Ben', 'ba', 'senior');
  // The CEO is the one who looks at held items: it holds them while it is active and reachable.
  await appoint(w);
  await online();
  // These tests cover the questions a git expert gets; simple mode (the default) is covered in simple-mode.test.ts.
  await q('UPDATE users SET git_expert=true WHERE id=$1', [w.owner.id]);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const online = () =>
  q(`UPDATE workstations SET connected=true, last_seen_at=$2 WHERE id=$1`, [
    w.workstationId,
    w.t.clock.now(),
  ]);
const flush = () => w.t.app.ctx.notifier.flush();
const items = () =>
  q(`SELECT * FROM desk_items WHERE subkind=$1 ORDER BY created_at`, [WORKING_BRANCH_SUBKIND]);
const deskIds = async () => ((await ok<any>(owner('GET', '/api/desk'))).items as any[]).map((i) => i.id);

describe('the working-branch question goes through the CEO routing', () => {
  it('a re-confirmation is non-urgent: held for the CEO, hidden from the desk, released to the manager on time', async () => {
    await q(
      `UPDATE project_repos SET working_branch='main', working_branch_set_at=now() - interval '5 hours' WHERE id=$1`,
      [w.repoId],
    );
    await ok(
      owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Autosave', description: 'x' }),
      201,
    );
    await flush();
    await until(async () => (await items()).length === 1, 5000, 'question');
    const [item] = await items();
    expect(item).toMatchObject({
      triage: 'pending',
      blocking: false,
      kind: 'question',
      routed_to: 'manager',
    });
    expect(item?.triage_deadline).toBeTruthy();
    expect(await deskIds()).not.toContain(item?.id);
    // no BA task is queued (the BA reporter is retired); the CEO is woken, and when it does not triage in time the
    // manager sees the item unchanged
    const tasks = await q(`SELECT kind FROM ba_tasks WHERE $1 = ANY(desk_item_ids)`, [item?.id]);
    expect(tasks).toEqual([]);
    w.t.clock.setOffset(11 * 60_000);
    await w.t.app.ctx.services.signals.run();
    expect(await deskIds()).toContain(item?.id);
    w.t.clock.setOffset(0);
  });

  it('a question that holds back a commit is blocking and reaches the manager at once', async () => {
    await q(`DELETE FROM ba_tasks`);
    await q(`DELETE FROM desk_items WHERE subkind=$1`, [WORKING_BRANCH_SUBKIND]);
    await q(`UPDATE project_repos SET working_branch=NULL WHERE id=$1`, [w.repoId]);
    await q(`UPDATE devops_requests SET status='done' WHERE hygiene IS NOT NULL`);
    const from = r.received.length;
    await ok(owner('POST', `/api/workstations/${w.workstationId}/hygiene/run`), 201);
    await w.t.app.ctx.services.dispatcher.run();
    const start = await r.waitFor('shift.start', (f) => f.kind === 'devops', 5000, from);
    r.accepted(start.shiftId);
    r.started(start.shiftId);
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
      3000,
      'shift running',
    );
    const { reportId } = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'devops_done',
      note: 'done',
      data: {
        summary: 'done',
        commands: [],
        hygiene: {
          repos: [
            {
              repoId: w.repoId,
              actions: [],
              problem: { kind: 'needs_branch', detail: 'x' },
              branches: ['develop', 'staging'],
              uncommitted: ['wip.txt'],
            },
          ],
        },
      },
    });
    await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
    const [item] = await items();
    expect(item).toMatchObject({ triage: 'none', blocking: true, pinned: true });
    expect(await deskIds()).toContain(item?.id);
    const tasks = await q(`SELECT kind FROM ba_tasks WHERE $1 = ANY(desk_item_ids)`, [item?.id]);
    expect(tasks).toEqual([]);
  });
});

describe('projections', () => {
  it('a rebuild keeps the confirmed branch, the known branches, the cadence and the findings', async () => {
    await ok(
      owner('PUT', `/api/projects/${w.projectId}/repos/${w.repoId}/working-branch`, { branch: 'develop' }),
    );
    await ok(owner('PUT', `/api/workstations/${w.workstationId}/hygiene`, { intervalHours: 6 }));
    await q(`UPDATE devops_requests SET status='done' WHERE hygiene IS NOT NULL`);
    const snap = async () => ({
      repos: (
        await q(
          `SELECT working_branch, working_branch_set_by, known_branches FROM project_repos WHERE id=$1`,
          [w.repoId],
        )
      ).map((x) => JSON.stringify(x)),
      ws: (
        await q(`SELECT hygiene_interval_hours, hygiene_last_at FROM workstations WHERE id=$1`, [
          w.workstationId,
        ])
      ).map((x) => JSON.stringify(x)),
      findings: (await q(`SELECT kind, subject, status FROM hygiene_findings ORDER BY subject, kind`)).map(
        (x) => JSON.stringify(x),
      ),
    });
    const before = await snap();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
    expect(before.repos[0]).toContain('develop');
    expect(PROJECTION_TABLES).toContain('hygiene_findings');
  });
});
