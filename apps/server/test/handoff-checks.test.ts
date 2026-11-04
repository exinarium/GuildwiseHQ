import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  designed,
  handoffEv,
  hireLeanTeam,
  leanAttach,
  leanPipeline,
  planned,
  resetLean,
  rpcOf,
  SHA1,
  verdict,
} from './helpers/lean.ts';
import { cardRow } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** Builder handoff checks: what the server keeps, refuses and shows (the runner runs the checks). */
let w: World;
let r: FakeRunner;
let p: ReturnType<typeof leanPipeline>;
let rpc: ReturnType<typeof rpcOf>;
beforeAll(async () => {
  w = await createWorld({
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false' },
    project: { workflowKey: 'code' },
    lean: true,
    integrationTests: 'off',
  });
  r = await w.connectRunner();
  p = leanPipeline(w, r);
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
const dispatcher = () => w.t.app.ctx.services.dispatcher;

const check = (over: Record<string, unknown> = {}) => ({
  name: 'lint',
  repoId: w.repoId,
  kind: 'check',
  cmd: ['pnpm', 'lint'],
  fix: ['pnpm', 'format'],
  timeoutMin: 5,
  confirmed: true,
  ...over,
});
const putSettings = (suites: unknown[], over: Record<string, unknown> = {}) =>
  call('PUT', settingsUrl(), { settings: { mode: 'off', suites, ...over } });
const evidenceOf = (status: string, extra: Record<string, unknown> = {}) => ({
  name: 'lint',
  command: 'pnpm lint',
  cwd: '.',
  status,
  exitCode: status === 'passed' ? 0 : 1,
  durationMs: 1200,
  summary: status,
  introduced: [],
  elsewhere: [],
  elsewhereCount: 0,
  ...extra,
});

async function team() {
  await freshState();
  await resetLean();
  dispatcher().cooldown.clear();
  await hireLeanTeam(w);
  await putSettings([]);
}
async function cardInBuild() {
  const card = await w.card({});
  await p.run('Pia', planned());
  await p.run('Arc', designed(card.ref));
  return card;
}

describe('the checks in the build brief', () => {
  it('lists only the confirmed checks of the card repository, and asks for detection while none were proposed', async () => {
    await team();
    await putSettings([
      check(),
      check({ name: 'proposed', confirmed: false }),
      check({ name: 'types', cmd: ['pnpm', 'typecheck'], fix: undefined }),
    ]);
    await cardInBuild();
    const start = await p.next('Bea');
    expect(start.brief.checks.suites.map((s: any) => s.name)).toEqual(['lint', 'types']);
    expect(start.brief.checks.detect).toBe(false);
    await p.startShift(r, start);
    await p.report(r, start.shiftId, handoffEv(), leanAttach());
    r.ended(start.shiftId, 'reported');
  });

  it('asks for detection once: a project without checks gets detect, and not after the runner proposed', async () => {
    await team();
    await cardInBuild();
    const start = await p.next('Bea');
    expect(start.brief.checks).toEqual({ suites: [], detect: true });
    await p.startShift(r, start);
    const res = await rpc(start.shiftId, 'env.suites.propose', {
      suites: [{ name: 'lint', cmd: ['pnpm', 'lint'], kind: 'check', cwd: '.', timeoutMin: 5 }],
    });
    expect(res.ok).toBe(true);
    const s = (await call('GET', settingsUrl())).settings;
    expect(s.suites).toHaveLength(1);
    expect(s.suites[0]).toMatchObject({ name: 'lint', kind: 'check', confirmed: false });
    expect(s.checkDetection).toEqual([w.repoId]);
    // a duplicate name adds nothing but still counts as detected
    await rpc(start.shiftId, 'env.suites.propose', {
      suites: [{ name: 'LINT', cmd: ['pnpm', 'lint'], kind: 'check' }],
    });
    expect((await call('GET', settingsUrl())).settings.suites).toHaveLength(1);
    // the proposed (unconfirmed) check is not in the brief of the next shift, and detection is over
    await p.report(r, start.shiftId, handoffEv(), leanAttach());
    r.ended(start.shiftId, 'reported');
    const card2 = await w.card({ title: 'Second' });
    await p.run('Pia', planned());
    await p.run('Arc', designed(card2.ref));
    const next = await p.next('Bea');
    expect(next.brief.checks).toEqual({ suites: [], detect: false });
    await p.startShift(r, next);
    r.ended(next.shiftId, 'reported');
  });
});

describe('settings with checks', () => {
  it('PUT keeps the stored checkDetection, confirming a check works, and the tester never sees checks', async () => {
    await team();
    await cardInBuild();
    const start = await p.next('Bea');
    await p.startShift(r, start);
    await rpc(start.shiftId, 'env.suites.propose', {
      suites: [{ name: 'lint', cmd: ['pnpm', 'lint'], kind: 'check', timeoutMin: 5 }],
    });
    // the client sends its own (empty) checkDetection: the server keeps its record
    const cur = (await call('GET', settingsUrl())).settings;
    await call('PUT', settingsUrl(), { settings: { ...cur, checkDetection: [] } });
    expect((await call('GET', settingsUrl())).settings.checkDetection).toEqual([w.repoId]);
    await call('POST', `${settingsUrl()}/suites/lint/confirm`, { confirmed: true });
    expect((await call('GET', settingsUrl())).settings.suites[0].confirmed).toBe(true);
    const listed = await rpc(start.shiftId, 'env.suites');
    expect(listed.ok).toBe(true);
    expect((listed.result as any).suites).toEqual([]);
    r.ended(start.shiftId, 'reported');
  });

  it('refuses a check that runs longer than 10 minutes and a fix on a test suite', async () => {
    await team();
    const bad = await call(
      'PUT',
      settingsUrl(),
      { settings: { mode: 'off', suites: [check({ timeoutMin: 11 })] } },
      400,
    );
    expect(JSON.stringify(bad)).toContain('at most 10 minutes');
    const bad2 = await call(
      'PUT',
      settingsUrl(),
      { settings: { mode: 'off', suites: [check({ name: 'api', kind: 'integration' })] } },
      400,
    );
    expect(JSON.stringify(bad2)).toContain('only a check has a fix command');
  });

  it('canRunChecks follows the checks capability of the workstations', async () => {
    await team();
    const res = await call('GET', settingsUrl());
    expect(typeof res.canRunChecks).toBe('boolean');
    await q(`UPDATE workstation_capabilities SET capabilities = array_remove(capabilities, 'checks:1')`);
    expect((await call('GET', settingsUrl())).canRunChecks).toBe(false);
    await q(`UPDATE workstation_capabilities SET capabilities = capabilities || ARRAY['checks:1']::text[]`);
    expect((await call('GET', settingsUrl())).canRunChecks).toBe(true);
  });
});

describe('a handoff with checks', () => {
  it('stores passing checks with the evidence, bound to the commit, and shows them to the reviewers and the owner', async () => {
    await team();
    await putSettings([check()]);
    const card = await cardInBuild();
    const checks = [
      evidenceOf('passed'),
      evidenceOf('preexisting', { name: 'types', elsewhereCount: 3, elsewhere: ['a.ts:1 x'] }),
    ];
    const res = (await p.runAt('Bea', handoffEv(), leanAttach(SHA1, ['src/feature.ts'], { checks }), SHA1))
      .res;
    expect(res.accepted).toBe(true);
    const row = await cardRow(card.id);
    expect(row.build_evidence.sha).toBe(SHA1);
    expect(row.build_evidence.checks.map((c: any) => c.status)).toEqual(['passed', 'preexisting']);
    // the pre-reviewer's brief carries them
    const start = await p.next('Pre');
    expect(start.brief.buildEvidence.checks).toHaveLength(2);
    expect(start.brief.buildEvidence.checks[1]).toMatchObject({ name: 'types', elsewhereCount: 3 });
    await p.startShift(r, start, SHA1);
    await p.report(r, start.shiftId, verdict('approve'));
    r.ended(start.shiftId, 'reported');
    // the card DTO shows them next to the build and test commands
    const detail = await call('GET', `/api/cards/${card.id}`);
    const rows = detail.card.lean.evidence.commands as Array<{ kind: string; status: string }>;
    expect(rows.filter((c) => c.kind === 'check').map((c) => c.status)).toEqual([
      'passed',
      'passed (failures only in files the card did not change)',
    ]);
  });

  it('refuses a failed check (defence in depth), with the text naming the check and the fix', async () => {
    await team();
    await cardInBuild();
    const start = await p.next('Bea');
    await p.startShift(r, start);
    const res = await p.report(
      r,
      start.shiftId,
      handoffEv(),
      leanAttach(SHA1, ['src/feature.ts'], {
        checks: [evidenceOf('failed', { summary: '2 problems', fix: 'pnpm format' })],
      }),
    );
    expect(res.accepted).toBe(false);
    expect(res.error).toContain('"lint"');
    expect(res.error).toContain('pnpm format');
    r.ended(start.shiftId, 'reported');
  });

  it('accepts a handoff without checks even when the project has a confirmed check (an older runner)', async () => {
    await team();
    await putSettings([check()]);
    const card = await cardInBuild();
    const res = (await p.runAt('Bea', handoffEv(), leanAttach(), SHA1)).res;
    expect(res.accepted).toBe(true);
    const row = await cardRow(card.id);
    expect(row.stage).toBe('pre_review');
    expect(row.build_evidence.checks).toBeUndefined();
  });

  it('a check that could not run does not block, and the card says so', async () => {
    await team();
    await putSettings([check()]);
    const card = await cardInBuild();
    const res = (
      await p.runAt(
        'Bea',
        handoffEv(),
        leanAttach(SHA1, ['src/feature.ts'], {
          checks: [evidenceOf('error', { summary: 'missing tool: pnpm' })],
        }),
        SHA1,
      )
    ).res;
    expect(res.accepted).toBe(true);
    const msgs = await q(
      `SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system' ORDER BY created_at`,
      [card.id],
    );
    expect(msgs.map((m: any) => m.body).join('\n')).toContain('could not run: "lint" (missing tool: pnpm)');
    expect(msgs.map((m: any) => m.body).join('\n')).toContain('unverified');
  });
});
