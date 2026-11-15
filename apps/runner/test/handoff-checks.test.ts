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
const reportsOf = (kind: string) =>
  (h?.server.of('shift.report') ?? []).filter((r) => (r.report as { kind: string }).kind === kind);
const outcomes = () => reportsOf('outcome');
const comments = () => reportsOf('comment');

function run(
  checks: ShiftBrief['checks'],
  script: (wt: string, post: () => Promise<Post>) => Promise<void>,
  serverOpts: Parameters<typeof startHarness>[0] = {},
  runnerOpts: Parameters<typeof startHarness>[1] = {},
) {
  const adapter = new ScriptedAdapter(async (i, ctl) => {
    const post = () =>
      ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: EVIDENCE },
      });
    await script(i.cwd, post);
  });
  return startHarness(serverOpts, { adapters: new Map([['mock', adapter]]), ...runnerOpts }).then(
    async (harness) => {
      h = harness;
      await harness.runShift({
        stage: 'build',
        outcomes: OUTCOMES,
        briefExtra: checks ? { checks } : {},
      });
      return harness;
    },
  );
}

describe('checks at aom handoff', () => {
  it('refuses a handoff whose changed file fails a confirmed check: no outcome reaches the server, the refusal is posted on the card; the fixed commit goes through with the evidence', async () => {
    const posts: Post[] = [];
    await run({ suites: [fmtCheck()], detect: false }, async (wt, post) => {
      commit(wt, 'a.txt', 'BAD-FORMAT\n', 'bad');
      posts.push(await post());
      expect(outcomes()).toHaveLength(0);
      // the same refusal again is not posted twice
      posts.push(await post());
      commit(wt, 'a.txt', 'ok\n', 'fixed');
      posts.push(await post());
    });
    const [first, again, second] = posts;
    expect(first?.json.accepted).toBe(false);
    expect(first?.json.error).toContain('the check "fmt"');
    expect(first?.json.error).toContain('src/a.txt');
    expect(first?.json.error).toContain('Fix: `sh -c');
    expect(again?.json.accepted).toBe(false);
    expect(second?.json.accepted).toBe(true);
    expect(second?.json.message).toContain('Checks: fmt passed');
    const reports = outcomes();
    expect(reports).toHaveLength(1);
    const checks = reports[0]?.checks;
    expect(checks?.[0]).toMatchObject({ name: 'fmt', status: 'passed', exitCode: 0 });
    expect(reports[0]?.headSha).toBeTruthy();
    expect(reports[0]?.checksPolicy).toBe(2);
    const refusals = comments();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.checks?.[0]).toMatchObject({ name: 'fmt', status: 'failed' });
    expect(refusals[0]?.checksPolicy).toBe(2);
    expect(String((refusals[0]?.report as { note?: string } | undefined)?.note)).toContain('refused');
  }, 60_000);

  it('whole repository: a finding in a file the card did not change refuses the handoff (a red branch is refused like any other)', async () => {
    const preexisting = fmtCheck({
      name: 'lint',
      cmd: ['sh', '-c', 'echo "README.md:1:1 old problem"; exit 1'],
    });
    await run({ suites: [preexisting], detect: false }, async (wt, post) => {
      commit(wt, 'a.txt', 'ok\n', 'change');
      const r = await post();
      expect(r.json.accepted).toBe(false);
      expect(r.json.error).toContain('In other files (1):');
      expect(r.json.error).toContain('README.md:1:1 old problem');
    });
    expect(outcomes()).toHaveLength(0);
    expect(comments()[0]?.checks?.[0]).toMatchObject({ status: 'failed', elsewhereCount: 1 });
  }, 60_000);

  it('a timed-out lint check refuses the handoff with its last output lines; the refusal is posted with the checks', async () => {
    const hang = fmtCheck({
      name: 'lint',
      cmd: ['sh', '-c', 'echo "Verifying lockfile against supply-chain policies"; sleep 30'],
    });
    let res: Post | undefined;
    await run(
      { suites: [hang], detect: false },
      async (wt, post) => {
        commit(wt, 'a.txt', 'ok\n', 'change');
        res = await post();
      },
      {},
      { checksBudgetMs: 3000 },
    );
    expect(res?.json.accepted).toBe(false);
    expect(res?.json.error).toContain('"lint"');
    expect(res?.json.error).toContain('did not produce a verdict (timed out)');
    expect(res?.json.error).toContain('Verifying lockfile against supply-chain policies');
    expect(res?.json.error).toContain('aom question --topic environment');
    expect(outcomes()).toHaveLength(0);
    expect(comments()[0]?.checks?.[0]).toMatchObject({ name: 'lint', status: 'timeout' });
  }, 120_000);

  it('a failing E2E test file on the card branch is deferred (owed by the tester) for a builder; it refuses the tester of a tests-only build', async () => {
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
    const reports = outcomes();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.checks?.[0]).toMatchObject({ name: 'fmt', status: 'deferred', owedBy: 'tester' });
    expect(reports[0]?.checks?.[0]?.owed?.[0]).toContain('e2e/login.spec.ts');
    // the server still gets the whole card diff
    expect(reports[0]?.changedPaths).toEqual(expect.arrayContaining(['e2e/login.spec.ts', 'src/a.txt']));
  }, 90_000);

  it('without brief.checks the report has no checks (an older server)', async () => {
    await run(undefined, async (wt, post) => {
      commit(wt, 'a.txt', 'BAD-FORMAT\n', 'bad');
      expect((await post()).json.accepted).toBe(true);
    });
    const reports = outcomes();
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

  describe('every role that hands off changed files', () => {
    const lintE2e = () =>
      fmtCheck({
        name: 'lint',
        cmd: [
          'sh',
          '-c',
          'for d in src e2e docs; do [ -d $d ] && grep -rn BAD-FORMAT $d && exit 1; done; exit 0',
        ],
      });
    const TEST_OUTCOMES: ShiftBrief['shift']['outcomes'] = [
      { id: 'pass', label: 'Pass', kind: 'success', data: 'testEvidence' },
      { id: 'fail', label: 'Fail', kind: 'failure', data: 'testEvidence' },
    ];
    const passReport = { kind: 'outcome', outcomeId: 'pass', note: 'ok', data: { summary: 'green' } };
    const writeCommit = (wt: string, rel: string, text: string) => {
      execFileSync('mkdir', ['-p', join(wt, rel, '..')]);
      writeFileSync(join(wt, rel), text);
      sh(wt, 'git', ['add', '-A']);
      execFileSync('git', ['commit', '-q', '-m', rel], { cwd: wt });
    };

    it('a tester pass runs the checks: its own E2E finding refuses it, the fixed spec passes with the evidence; no unit tests run', async () => {
      const posts: Post[] = [];
      const units = [
        IntegrationSuiteSchema.parse({
          name: 'unit src',
          repoId: REPO,
          kind: 'unit',
          cmd: ['sh', '-c', 'exit 0'],
          handoffCmd: ['sh', '-c', 'exit 1', '{files}'],
        }),
      ];
      const adapter = new ScriptedAdapter(async (i, ctl) => {
        if (i.agent.roleKey !== 'tester') return;
        writeCommit(i.cwd, 'e2e/login.spec.ts', 'BAD-FORMAT\n');
        posts.push(await ctl.post('/v1/report', { report: passReport }));
        writeCommit(i.cwd, 'e2e/login.spec.ts', 'ok\n');
        posts.push(await ctl.post('/v1/report', { report: passReport }));
      });
      h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
      await h.runShift({ stage: 'build' });
      await h.runShift({
        stage: 'test',
        outcomes: TEST_OUTCOMES,
        briefExtra: { checks: { suites: [lintE2e()], detect: false, units } },
      });
      expect(posts[0]?.json.accepted).toBe(false);
      expect(posts[0]?.json.error).toContain('e2e/login.spec.ts');
      expect(posts[1]?.json.accepted).toBe(true);
      const pass = outcomes().at(-1);
      // a tester never runs unit tests (the confirmed unit suite would fail if it ran)
      expect(pass?.checks?.map((c: { kind: string }) => c.kind)).toEqual(['check']);
      expect(pass?.checks?.[0]).toMatchObject({ name: 'lint', status: 'passed' });
      expect(pass?.checksPolicy).toBe(2);
    }, 120_000);

    it('a writer is refused for a code finding it may not edit and told to ask; checks attach to its done report when clean', async () => {
      const writer = BUILTIN_ROLES.find((r) => r.key === 'writer')!;
      const posts: Post[] = [];
      const adapter = new ScriptedAdapter(async (i, ctl) => {
        if (i.agent.roleKey === 'builder') {
          writeCommit(i.cwd, 'src/a.txt', 'BAD-FORMAT\n');
          return;
        }
        writeCommit(i.cwd, 'docs/x.md', 'docs\n');
        posts.push(
          await ctl.post('/v1/report', {
            report: { kind: 'outcome', outcomeId: 'done', note: 'documented', data: {} },
          }),
        );
      });
      h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
      await h.runShift({ stage: 'build' });
      const base = makeShiftStart({ stage: 'test', remoteNormalized: h.repo.remoteNormalized }) as {
        agent: Record<string, unknown>;
      };
      await h.runShift({
        stage: 'test',
        outcomes: [{ id: 'done', label: 'Docs done', kind: 'success', data: 'none' }],
        briefExtra: { checks: { suites: [lintE2e()], detect: false } },
        startExtra: { agent: { ...base.agent, roleKey: 'writer', permissions: writer.permissions } },
      });
      expect(posts[0]?.json.accepted).toBe(false);
      expect(posts[0]?.json.error).toContain('Only a builder can fix these files');
      expect(posts[0]?.json.error).toContain('aom question --topic code');
      expect(comments().at(-1)?.checks?.[0]).toMatchObject({ status: 'failed', owedBy: 'builder' });
    }, 120_000);

    it('a builder handoff runs the unit tests of the changed files; a worktree never prepared is prepared once before the checks', async () => {
      const prepCalls: Array<number | undefined> = [];
      const units = [
        IntegrationSuiteSchema.parse({
          name: 'unit src',
          repoId: REPO,
          kind: 'unit',
          cmd: ['sh', '-c', 'exit 0'],
          handoffCmd: ['sh', '-c', 'echo ran "$@"; exit 0', 'sh', '{files}'],
        }),
      ];
      const res: Post[] = [];
      await run(
        { suites: [], detect: false, units },
        async (wt, post) => {
          commit(wt, 'a.txt', 'ok\n', 'change');
          res.push(await post());
          res.push(await post());
        },
        {},
        {
          prepareWorktree: async (i) => {
            prepCalls.push(i.budgetMs);
            return { ok: true, steps: [] };
          },
        },
      );
      expect(res[0]?.json.accepted).toBe(true);
      const ev = outcomes()[0]?.checks;
      expect(ev?.[0]).toMatchObject({ kind: 'unit', name: 'unit src', status: 'passed' });
      expect(ev?.[0]?.command).toContain('src/a.txt');
      // the new worktree's own preparation, then once more before the checks (no dependency step was done)
      expect(prepCalls.length).toBe(2);
      // the refresh at the handoff is bounded (the whole handoff must end inside the agent's command wait)
      expect(prepCalls[1]).toBe(60_000);
    }, 60_000);
  });

  it('a custom role at a build stage keeps its checks (S2)', async () => {
    const builder = BUILTIN_ROLES.find((r) => r.key === 'builder')!;
    let res: Post | undefined;
    const adapter = new ScriptedAdapter(async (i, ctl) => {
      commit(i.cwd, 'a.txt', 'BAD-FORMAT\n', 'bad');
      res = await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: EVIDENCE },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const base = makeShiftStart({ stage: 'build', remoteNormalized: h.repo.remoteNormalized }) as {
      agent: Record<string, unknown>;
    };
    await h.runShift({
      stage: 'build',
      outcomes: OUTCOMES,
      briefExtra: { checks: { suites: [fmtCheck()], detect: false } },
      startExtra: { agent: { ...base.agent, roleKey: 'app_developer', permissions: builder.permissions } },
    });
    expect(res?.json.accepted).toBe(false);
    expect(res?.json.error).toContain('the check "fmt"');
  }, 60_000);

  describe('a suite card', () => {
    it('the runner runs the unit suites; the tester may not report one; no pass while one failed; the fail note gets a bug section per failing file', async () => {
      const rpcs: Array<{ method: string; params: Record<string, unknown> }> = [];
      const seen: Record<string, Post> = {};
      const regressionUnits = [
        IntegrationSuiteSchema.parse({
          name: 'unit shared',
          repoId: REPO,
          kind: 'unit',
          cmd: ['sh', '-c', 'echo " FAIL  test/a.test.ts > adds"; exit 1'],
        }),
      ];
      const adapter = new ScriptedAdapter(async (i, ctl) => {
        if (i.agent.roleKey !== 'tester') return;
        seen.relay = await ctl.post('/v1/rpc', {
          method: 'test.suite',
          params: { name: 'unit shared', status: 'passed' },
        });
        for (let n = 0; n < 50 && !rpcs.some((r) => r.method === 'test.suite'); n++)
          await new Promise((r) => setTimeout(r, 100));
        seen.pass = await ctl.post('/v1/report', {
          report: { kind: 'outcome', outcomeId: 'pass', note: 'ok', data: { summary: 'green' } },
        });
        seen.fail = await ctl.post('/v1/report', {
          report: {
            kind: 'outcome',
            outcomeId: 'fail',
            note: 'Target commit: unknown',
            data: { summary: 'unit failures', title: '1 failure' },
          },
        });
      });
      h = await startHarness(
        {
          rpc: (m) => {
            rpcs.push({ method: m.method, params: m.params as Record<string, unknown> });
            return { ok: true, result: {} };
          },
        },
        { adapters: new Map([['mock', adapter]]) },
      );
      await h.runShift({ stage: 'build' });
      await h.runShift({
        stage: 'test',
        cardType: 'regression',
        outcomes: [
          { id: 'pass', label: 'Pass', kind: 'success', data: 'testEvidence' },
          { id: 'fail', label: 'Fail', kind: 'failure', data: 'testEvidence' },
        ],
        briefExtra: { regressionUnits },
      });
      expect(seen.relay?.json.ok ?? seen.relay?.json.accepted).toBeFalsy();
      expect(JSON.stringify(seen.relay?.json)).toContain('is a unit suite');
      const reported = rpcs.find((r) => r.method === 'test.suite');
      expect(reported?.params).toMatchObject({
        name: 'unit shared',
        status: 'failed',
        kind: 'unit',
        measured: true,
      });
      expect(seen.pass?.json.accepted).toBe(false);
      expect(seen.pass?.json.error).toContain('aom test fail');
      expect(seen.fail?.json.accepted).toBe(true);
      const note = String((outcomes().at(-1)?.report as { note?: string } | undefined)?.note);
      expect(note).toContain('Bug: Unit tests fail in test/a.test.ts (unit shared)');
      expect(note).toContain('Test: unit:unit shared:test/a.test.ts');
    }, 120_000);
  });
});
