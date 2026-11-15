import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checksBrief } from '../src/runner-gateway/brief.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { rpcOf } from './helpers/lean.ts';
import { cardRow, hireTeam, pipeline, testFail, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Handoff checks policy 2 (whole repository, error and timeout refuse) on the server side, the tester's checks brief, the
 * refusal comment and its desk alert, and the unit suites of a suite card (the runner runs and reports them).
 */
let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
let rpc: ReturnType<typeof rpcOf>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
  rpc = rpcOf(r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), status);
const settingsUrl = () => `/api/projects/${w.projectId}/integration-tests`;
const lint = { name: 'lint', kind: 'check', cmd: ['pnpm', 'lint'], timeoutMin: 5, confirmed: true };
const unitShared = {
  name: 'unit shared',
  kind: 'unit',
  cwd: 'packages/shared',
  cmd: ['pnpm', 'test'],
  handoffCmd: ['npx', 'vitest', 'related', '--run', '{files}'],
  timeoutMin: 20,
  confirmed: true,
};
const putSettings = (suites: Array<Record<string, unknown>>) =>
  call('PUT', settingsUrl(), {
    settings: { mode: 'off', suites: suites.map((s) => ({ repoId: w.repoId, ...s })) },
  });
const ev = (status: string, extra: Record<string, unknown> = {}) => ({
  name: 'lint',
  command: 'pnpm lint',
  cwd: '.',
  status,
  exitCode: null,
  durationMs: 1000,
  summary: status === 'timeout' ? 'timed out after 5 minutes' : status,
  introduced: [],
  elsewhere: [],
  elsewhereCount: 0,
  ...extra,
});
const regression = () =>
  ok<any>(
    w.t.req('POST', `/api/projects/${w.projectId}/regression`, {
      cookie: w.owner.cookie,
      body: { platform: 'web' },
    }),
    201,
  );

async function testerAtTest() {
  await freshState();
  await hireTeam(w);
  await putSettings([lint, unitShared]);
  const card = await w.card({ title: 'Feature' });
  await p.toTest('Bea', ['Rex']);
  return card;
}

describe('the tester at Test', () => {
  it('gets the checks (never the unit suites); a timed-out check refuses its pass under policy 2, a clean one is kept on the handoff', async () => {
    const card = await testerAtTest();
    const start = await p.next('Tess');
    expect(start.brief.checks?.suites.map((s: any) => s.name)).toEqual(['lint']);
    expect(start.brief.checks?.units).toBeUndefined();
    expect(start.brief.regressionUnits).toBeUndefined();
    await p.startShift(r, start);
    const refused = await p.report(r, start.shiftId, testPass(), {
      checks: [ev('timeout')],
      checksPolicy: 2,
    });
    expect(refused.accepted).toBe(false);
    expect(refused.error).toContain('did not produce a verdict (timed out');
    // a clean run passes
    const older = await p.report(r, start.shiftId, testPass(), { checks: [ev('passed')], checksPolicy: 2 });
    expect(older.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    const h = (
      await q(
        `SELECT data FROM card_handoffs WHERE card_id=$1 AND stage='test' ORDER BY created_at DESC LIMIT 1`,
        [card.id],
      )
    )[0];
    expect(h?.data.handoffChecks?.[0]).toMatchObject({ name: 'lint', status: 'passed' });
  });

  it('the builder gets the unit suites and the unit detection request', async () => {
    await freshState();
    await hireTeam(w);
    await putSettings([lint, unitShared]);
    await w.card({ title: 'Feature' });
    const start = await p.next('Bea');
    expect(start.brief.checks?.units?.map((s: any) => s.name)).toEqual(['unit shared']);
    expect(start.brief.checks?.detectUnits).toBeUndefined();
    await p.startShift(r, start);
    r.ended(start.shiftId, 'reported');
    await putSettings([lint]);
    await w.card({ title: 'Second' });
    const next = await p.next('Bea');
    expect(next.brief.checks?.detectUnits).toBe(true);
    // a proposed unit suite marks the repository
    await p.startShift(r, next);
    const res = await rpc(next.shiftId, 'env.suites.propose', {
      suites: [{ name: 'unit web', kind: 'unit', cwd: 'apps/web', cmd: ['pnpm', 'test'] }],
    });
    expect(res.ok).toBe(true);
    const s = (await call('GET', settingsUrl())).settings;
    expect(s.unitDetection).toEqual([w.repoId]);
    expect(s.suites.find((x: any) => x.name === 'unit web')).toMatchObject({
      kind: 'unit',
      confirmed: false,
      timeoutMin: 30,
    });
    r.ended(next.shiftId, 'reported');
  });
});

describe('a refused handoff', () => {
  it('the comment with checks is stored on the card; the same check erroring twice in a row raises one desk alert', async () => {
    await testerAtTest();
    const start = await p.next('Tess');
    await p.startShift(r, start);
    const comment = { kind: 'comment', note: 'The handoff checks refused this handoff' };
    const err = ev('error', { summary: 'missing tool or script ("biome: not found")' });
    await p.report(r, start.shiftId, comment, { checks: [err], headSha: 'abc1234', checksPolicy: 2 });
    let msgs = await q(`SELECT data FROM thread_messages WHERE data ? 'handoffChecks' ORDER BY created_at`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.data.handoffChecks).toMatchObject({ refused: true, headSha: 'abc1234' });
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='handoff_check_broken'`)).toHaveLength(0);
    await p.report(r, start.shiftId, comment, { checks: [err], headSha: 'abc1234', checksPolicy: 2 });
    await p.report(r, start.shiftId, comment, { checks: [err], headSha: 'abc1234', checksPolicy: 2 });
    msgs = await q(`SELECT data FROM thread_messages WHERE data ? 'handoffChecks'`);
    expect(msgs).toHaveLength(3);
    const alerts = await q(
      `SELECT title, body, blocking FROM desk_items WHERE subkind='handoff_check_broken'`,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ title: 'Handoff check "lint" cannot run', blocking: false });
    expect(alerts[0]?.body).toContain('unconfirm the check');
    r.ended(start.shiftId, 'reported');
  });
});

const setPolicy2 = async (on: boolean) => {
  await q(`UPDATE workstation_capabilities SET capabilities = array_remove(capabilities, 'checks:2')`);
  if (on)
    await q(`UPDATE workstation_capabilities SET capabilities = capabilities || ARRAY['checks:2']::text[]`);
};

describe('unit suites of a suite card', () => {
  it('in the brief; the tester may not report one; no pass while unreported or failing; a failing file files a bug once', async () => {
    await freshState();
    await hireTeam(w);
    await putSettings([unitShared]);
    await setPolicy2(true);
    await regression();
    const start = await p.next('Tess');
    expect(start.brief.regressionUnits?.map((s: any) => s.name)).toEqual(['unit shared']);
    await p.startShift(r, start);
    const byTester = await rpc(start.shiftId, 'test.suite', { name: 'unit shared', status: 'passed' });
    expect(byTester.ok).toBe(false);
    expect(byTester.error).toContain('the runner runs it');
    const noResult = await p.report(r, start.shiftId, testPass());
    expect(noResult.accepted).toBe(false);
    expect(noResult.error).toContain('unit shared');
    const measured = await rpc(start.shiftId, 'test.suite', {
      name: 'unit shared',
      status: 'failed',
      failed: 1,
      failures: ['packages/shared/test/a.test.ts'],
      kind: 'unit',
      measured: true,
    });
    expect(measured.ok).toBe(true);
    expect((await q(`SELECT kind, status FROM test_suite_results`))[0]).toEqual({
      kind: 'unit',
      status: 'failed',
    });
    expect((await p.report(r, start.shiftId, testPass())).accepted).toBe(false);
    const bugNote =
      'Target commit: unknown\n\nBug: Unit tests fail in packages/shared/test/a.test.ts (unit shared)\nTest: unit:unit shared:packages/shared/test/a.test.ts\nfails';
    const fail = { ...testFail('1 failure in the web run'), note: bugNote };
    expect((await p.report(r, start.shiftId, fail)).accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    const bugs = () => q(`SELECT id FROM cards WHERE card_type='bug' AND origin='regression'`);
    expect(await bugs()).toHaveLength(1);
    // the same failure on the next run is not filed again
    await regression();
    const again = await p.next('Tess');
    await p.startShift(r, again);
    await rpc(again.shiftId, 'test.suite', {
      name: 'unit shared',
      status: 'failed',
      kind: 'unit',
      measured: true,
    });
    expect((await p.report(r, again.shiftId, fail)).accepted).toBe(true);
    r.ended(again.shiftId, 'reported');
    expect(await bugs()).toHaveLength(1);
  });

  it("a runner without checks:2 keeps today's behaviour: no regression units, the pass goes through with a note (S1)", async () => {
    await freshState();
    await hireTeam(w);
    await putSettings([unitShared]);
    await setPolicy2(false);
    await regression();
    const start = await p.next('Tess');
    expect(start.brief.regressionUnits).toBeUndefined();
    await p.startShift(r, start);
    expect((await p.report(r, start.shiftId, testPass())).accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    const card = (await q(`SELECT id FROM cards WHERE origin='regression' ORDER BY number DESC LIMIT 1`))[0]!;
    expect((await cardRow(card.id)).status).toBe('done');
    const notes = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system'`, [card.id]);
    expect(notes.map((n: any) => n.body).join('\n')).toContain('did not run');
    await setPolicy2(true);
  });

  it('a measured pass lets the suite card pass', async () => {
    await freshState();
    await hireTeam(w);
    await putSettings([unitShared]);
    await setPolicy2(true);
    await regression();
    const start = await p.next('Tess');
    await p.startShift(r, start);
    await rpc(start.shiftId, 'test.suite', {
      name: 'unit shared',
      status: 'passed',
      kind: 'unit',
      measured: true,
    });
    expect((await p.report(r, start.shiftId, testPass())).accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    const card = (await q(`SELECT id FROM cards WHERE origin='regression' ORDER BY number DESC LIMIT 1`))[0]!;
    expect((await cardRow(card.id)).status).toBe('done');
  });
});

describe('who gets the checks brief', () => {
  const project = () => ({
    integration_tests: {
      mode: 'off',
      suites: [
        { name: 'lint', repoId: w.repoId, kind: 'check', cmd: ['pnpm', 'lint'], confirmed: true },
        { ...unitShared, repoId: w.repoId },
      ],
    },
  });
  const card = () => ({ repo_id: w.repoId, card_type: 'feature', origin: null });
  it('builder, tester, writer and any role at a build stage that keeps evidence (S2); not DevOps, not without a worktree', () => {
    const at = (role: string, stage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      checksBrief(card() as never, project() as never, stage, { role_key: role, ...extra } as never, true);
    expect(at('writer', { worktree: 'reuse' }).checks?.suites.map((x) => x.name)).toEqual(['lint']);
    expect(at('writer', { worktree: 'reuse' }).checks?.units).toBeUndefined();
    expect(
      at('app_developer', { worktree: 'create', requireBuildEvidence: true }).checks?.suites,
    ).toHaveLength(1);
    expect(at('app_developer', { worktree: 'create' })).toEqual({});
    expect(at('builder', { worktree: 'none' })).toEqual({});
    expect(at('builder', { worktree: 'create' }, { is_devops: true })).toEqual({});
    expect(at('builder', { worktree: 'create' }).checks?.units?.map((x) => x.name)).toEqual(['unit shared']);
  });
});
