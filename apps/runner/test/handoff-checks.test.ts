import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, IntegrationSuiteSchema, type ShiftBrief } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, sh } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const REPO = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const OUTCOMES: ShiftBrief['shift']['outcomes'] = [
  { id: 'handoff', label: 'Hand off for review', kind: 'success', data: 'buildHandoff' },
];
const EVIDENCE = {
  buildEvidence: {
    commands: [
      { kind: 'build', command: 'mock build', status: 'passed', result: 'ok' },
      { kind: 'test', command: 'mock tests', status: 'passed', result: '3 passed' },
    ],
  },
};
const fmtCheck = (o: Record<string, unknown> = {}) =>
  IntegrationSuiteSchema.parse({
    name: 'fmt',
    repoId: REPO,
    kind: 'check',
    cmd: ['sh', '-c', 'if grep -rn BAD-FORMAT src; then exit 1; fi'],
    fix: ['sh', '-c', 'sed -i s/BAD-FORMAT/ok/ src/*.txt'],
    timeoutMin: 1,
    ...o,
  });
const commit = (wt: string, file: string, text: string, msg: string) => {
  execFileSync('mkdir', ['-p', join(wt, 'src')]);
  writeFileSync(join(wt, 'src', file), text);
  sh(wt, 'git', ['add', '-A']);
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: wt });
};
type Post = { status: number; json: Record<string, any> };

function run(
  checks: ShiftBrief['checks'],
  script: (wt: string, post: () => Promise<Post>) => Promise<void>,
  serverOpts: Parameters<typeof startHarness>[0] = {},
) {
  const adapter = new ScriptedAdapter(async (i, ctl) => {
    const post = () =>
      ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: EVIDENCE },
      });
    await script(i.cwd, post);
  });
  return startHarness(serverOpts, { adapters: new Map([['mock', adapter]]) }).then(async (harness) => {
    h = harness;
    await harness.runShift({
      stage: 'build',
      outcomes: OUTCOMES,
      briefExtra: checks ? { checks } : {},
    });
    return harness;
  });
}

describe('checks at aom handoff', () => {
  it('refuses a handoff whose changed file fails a confirmed check: nothing reaches the server; the fixed commit goes through with the evidence', async () => {
    const posts: Post[] = [];
    await run({ suites: [fmtCheck()], detect: false }, async (wt, post) => {
      commit(wt, 'a.txt', 'BAD-FORMAT\n', 'bad');
      posts.push(await post());
      expect(h?.server.of('shift.report')).toHaveLength(0);
      commit(wt, 'a.txt', 'ok\n', 'fixed');
      posts.push(await post());
    });
    const [first, second] = posts;
    expect(first?.json.accepted).toBe(false);
    expect(first?.json.error).toContain('the check "fmt"');
    expect(first?.json.error).toContain('src/a.txt');
    expect(first?.json.error).toContain('Fix: `sh -c');
    expect(second?.json.accepted).toBe(true);
    expect(second?.json.message).toContain('Checks: fmt passed');
    const reports = h?.server.of('shift.report') ?? [];
    expect(reports).toHaveLength(1);
    const checks = reports[0]?.checks;
    expect(checks?.[0]).toMatchObject({ name: 'fmt', status: 'passed', exitCode: 0 });
    expect(reports[0]?.headSha).toBeTruthy();
  }, 60_000);

  it('failures only in files the card did not change do not block; they are recorded as information', async () => {
    const preexisting = fmtCheck({
      name: 'lint',
      cmd: ['sh', '-c', 'echo "README.md:1:1 old problem"; exit 1'],
    });
    await run({ suites: [preexisting], detect: false }, async (wt, post) => {
      commit(wt, 'a.txt', 'ok\n', 'change');
      const r = await post();
      expect(r.json.accepted).toBe(true);
    });
    const checks = h?.server.of('shift.report')[0]?.checks;
    expect(checks?.[0]).toMatchObject({ status: 'preexisting', elsewhereCount: 1 });
  }, 60_000);

  it('a failing E2E test file on the card branch does not refuse a builder; it still refuses the tester of a tests-only build', async () => {
    // the check fails on BAD-FORMAT in src or in the E2E specs, naming the file
    const fmt = fmtCheck({
      cmd: ['sh', '-c', 'for d in src e2e; do [ -d $d ] && grep -rn BAD-FORMAT $d && exit 1; done; exit 0'],
    });
    const checks = { suites: [fmt], detect: false };
    const posts: Record<string, Post> = {};
    const adapter = new ScriptedAdapter(async (i, ctl) => {
      const post = () =>
        ctl.post('/v1/report', {
          report: { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: EVIDENCE },
        });
      if (i.agent.roleKey === 'tester') {
        execFileSync('mkdir', ['-p', join(i.cwd, 'e2e')]);
        writeFileSync(join(i.cwd, 'e2e', 'login.spec.ts'), 'BAD-FORMAT\n');
        sh(i.cwd, 'git', ['add', '-A']);
        execFileSync('git', ['commit', '-q', '-m', 'spec'], { cwd: i.cwd });
        posts.tester = await post();
        return;
      }
      commit(i.cwd, 'a.txt', 'ok\n', 'product change');
      posts.builder = await post();
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const tester = BUILTIN_ROLES.find((r) => r.key === 'tester')!;
    const base = makeShiftStart({ stage: 'build', remoteNormalized: h.repo.remoteNormalized }) as {
      agent: Record<string, unknown>;
    };
    // the tester works the build stage of a tests-only card
    h.server.send(
      'shift.start',
      makeShiftStart({
        stage: 'build',
        remoteNormalized: h.repo.remoteNormalized,
        outcomes: OUTCOMES,
        briefExtra: { checks },
        startExtra: { agent: { ...base.agent, roleKey: 'tester', permissions: tester.permissions } },
      }),
    );
    await h.server.waitFor('shift.ended', undefined, 60_000);
    expect(posts.tester?.json.accepted).toBe(false);
    expect(posts.tester?.json.error).toContain('e2e/login.spec.ts');
    // then the card is back with a builder: the tester's failing spec is not the builder's to fix
    await h.runShift({ stage: 'build', mode: 'reuse', outcomes: OUTCOMES, briefExtra: { checks } });
    expect(posts.builder?.json.accepted).toBe(true);
    const reports = h.server.of('shift.report');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.checks?.[0]).toMatchObject({ name: 'fmt', status: 'preexisting' });
    // the server still gets the whole card diff
    expect(reports[0]?.changedPaths).toEqual(expect.arrayContaining(['e2e/login.spec.ts', 'src/a.txt']));
  }, 90_000);

  it('without brief.checks the report has no checks (an older server)', async () => {
    await run(undefined, async (wt, post) => {
      commit(wt, 'a.txt', 'BAD-FORMAT\n', 'bad');
      expect((await post()).json.accepted).toBe(true);
    });
    const reports = h?.server.of('shift.report') ?? [];
    expect(reports).toHaveLength(1);
    expect(reports[0]?.checks).toBeUndefined();
  }, 60_000);

  it('does not run the checks for evidence the server would refuse', async () => {
    const adapter = new ScriptedAdapter(async (i, ctl) => {
      commit(i.cwd, 'a.txt', 'BAD-FORMAT\n', 'bad');
      const r = await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: {} },
      });
      expect(r.json.error).toContain('attach the build and unit test evidence');
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    await h.runShift({
      stage: 'build',
      outcomes: OUTCOMES,
      briefExtra: { checks: { suites: [fmtCheck()], detect: false } },
    });
    expect(h.server.of('shift.report')).toHaveLength(0);
  }, 60_000);

  it('a second handoff while the checks run is refused', async () => {
    const slow = fmtCheck({ cmd: ['sh', '-c', 'sleep 2'] });
    const posts: Post[] = [];
    await run({ suites: [slow], detect: false }, async (wt, post) => {
      commit(wt, 'a.txt', 'ok\n', 'change');
      const first = post();
      await new Promise((r) => setTimeout(r, 700));
      posts.push(await post());
      posts.push(await first);
    });
    expect(posts[0]?.json.error).toContain('still running');
    expect(posts[1]?.json.accepted).toBe(true);
  }, 60_000);

  it('detect: reads the base branch, not the builder branch: a workflow line added on the card branch is not proposed', async () => {
    const calls: Array<{ method: string }> = [];
    await run(
      { suites: [], detect: true },
      async (wt, post) => {
        writeFileSync(join(wt, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }));
        commit(wt, 'a.txt', 'ok\n', 'change');
        expect((await post()).json.accepted).toBe(true);
        await new Promise((r) => setTimeout(r, 500));
      },
      {
        rpc: (m) => {
          calls.push({ method: m.method });
          return { ok: true, result: {} };
        },
      },
    );
    expect(calls.filter((c) => c.method === 'env.suites.propose')).toHaveLength(0);
  }, 60_000);
});
