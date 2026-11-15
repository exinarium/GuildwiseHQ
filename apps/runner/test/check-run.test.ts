import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CheckEvidence, IntegrationSuiteSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { type CheckLaunch, runHandoffChecks } from '../src/checks/run.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const REPO = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const suite = (name: string, script: string, o: Record<string, unknown> = {}) =>
  IntegrationSuiteSchema.parse({ name, repoId: REPO, kind: 'check', cmd: ['sh', '-c', script], ...o });
const sh = async (argv: string[]): Promise<CheckLaunch> => ({
  cmd: argv[0] as string,
  args: argv.slice(1),
  env: { PATH: process.env.PATH ?? '' },
});

function setup() {
  const worktree = tmp('aom-chk-wt-');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  for (const f of ['a.ts', 'b.ts']) writeFileSync(join(worktree, 'src', f), 'x\n');
  return { worktree, logDir: join(tmp('aom-chk-log-'), 'checks') };
}
const run = (o: Partial<Parameters<typeof runHandoffChecks>[0]> & { suites: ReturnType<typeof suite>[] }) => {
  const s = setup();
  return runHandoffChecks({
    worktree: s.worktree,
    logDir: s.logDir,
    changedPaths: ['src/a.ts'],
    headSha: 'abcdef1234567890',
    launch: sh,
    ...o,
  });
};

describe('runHandoffChecks', () => {
  it('exit 0 passes', async () => {
    const r = await run({ suites: [suite('lint', 'echo fine')] });
    expect(r.evidence[0]).toMatchObject({ name: 'lint', status: 'passed', exitCode: 0 });
    expect(r.blocking).toEqual([]);
    expect(r.refusal).toBe('');
    expect(r.summary).toContain('lint passed');
  });

  it('a warning in a changed file never blocks: the tool exits 0 (errors-only flags keep it quiet otherwise)', async () => {
    const r = await run({ suites: [suite('lint', 'echo "src/a.ts:1:1 lint/style/noVar warn"; exit 0')] });
    expect(r.evidence[0]?.status).toBe('passed');
    expect(r.blocking).toEqual([]);
  });

  it('a folder outside the repository is not run', async () => {
    let launched = false;
    const r = await run({
      launch: async (a) => {
        launched = true;
        return sh(a);
      },
      suites: [suite('esc', 'echo hi', { cwd: '../..' }), suite('abs', 'echo hi', { cwd: '/etc' })],
    });
    expect(launched).toBe(false);
    expect(r.evidence.map((e) => e.status)).toEqual(['error', 'error']);
    expect(r.evidence[0]?.summary).toContain('inside the repository');
  });

  it('a failure blocks with findings in every file: the refusal groups them (this card, other files), with the fix and the log path', async () => {
    const s = setup();
    const r = await runHandoffChecks({
      worktree: s.worktree,
      logDir: s.logDir,
      changedPaths: ['src/a.ts'],
      headSha: 'abcdef1234567890',
      launch: sh,
      suites: [
        suite(
          'lint',
          'echo "src/a.ts:12:3 lint/style/useConst bad"; echo "src/b.ts:1:1 old"; echo "src/b.ts:2:1 old"; exit 1',
          {
            cmd: [
              'sh',
              '-c',
              'echo "src/a.ts:12:3 lint/style/useConst bad"; echo "src/b.ts:1:1 old"; echo "src/b.ts:2:1 old"; exit 1',
            ],
            fix: ['pnpm', 'format'],
          },
        ),
      ],
    });
    expect(r.blocking).toHaveLength(1);
    expect(r.evidence[0]).toMatchObject({
      status: 'failed',
      exitCode: 1,
      fix: 'pnpm format',
      elsewhereCount: 2,
    });
    expect(r.evidence[0]?.introduced).toEqual(['src/a.ts:12:3 lint/style/useConst bad']);
    expect(r.refusal).toContain('the check "lint"');
    expect(r.refusal).toContain('  src/a.ts:12:3 lint/style/useConst bad');
    expect(r.refusal).toContain('Fix: `pnpm format`');
    expect(r.evidence[0]?.elsewhere).toEqual(['src/b.ts:1:1 old', 'src/b.ts:2:1 old']);
    expect(r.refusal).toContain('In files this card changed (1):');
    expect(r.refusal).toContain('In other files (2):\n  src/b.ts:1:1 old\n  src/b.ts:2:1 old');
    expect(r.refusal).toContain('also in files you did not change');
    expect(r.refusal).toContain('aom question --topic environment');
    expect(r.refusal).toContain('Nothing was handed on.');
    const log = /Full output: (.+)/.exec(r.refusal)?.[1] as string;
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('src/b.ts:2:1 old');
  });

  it('whole repository: failures only in files the card did not change block too (no "preexisting" pass)', async () => {
    const r = await run({ suites: [suite('lint', 'echo "src/b.ts:1:1 old"; exit 1')] });
    expect(r.evidence[0]).toMatchObject({ status: 'failed', elsewhereCount: 1, introduced: [] });
    expect(r.blocking).toHaveLength(1);
    expect(r.refusal).toContain('In other files (1):');
  });

  it('a failure that names no file is an error, and an error blocks with the last lines of the output', async () => {
    const r = await run({ suites: [suite('lint', 'echo first; echo boom; exit 2')] });
    expect(r.evidence[0]).toMatchObject({ status: 'error', tail: ['first', 'boom'] });
    expect(r.evidence[0]?.summary).toContain('without naming a file');
    expect(r.blocking).toHaveLength(1);
    expect(r.refusal).toContain('did not produce a verdict (error)');
    expect(r.refusal).toContain('Last lines of its output:\n  first\n  boom');
  });

  it('a missing binary, exit 127 and a missing script are errors that block, naming what is missing', async () => {
    const r = await run({
      suites: [
        suite('a', 'x', { cmd: ['definitely-not-a-binary-xyz'] }),
        suite('b', 'exit 127'),
        suite('c', 'echo "ERR_PNPM_NO_SCRIPT Missing script: lint"; exit 1'),
      ],
    });
    expect(r.evidence.map((e) => e.status)).toEqual(['error', 'error', 'error']);
    expect(r.evidence[0]?.summary).toContain('missing tool');
    expect(r.evidence[2]?.summary).toContain('ERR_PNPM_NO_SCRIPT Missing script: lint');
    expect(r.blocking).toHaveLength(3);
  });

  it('a bare ENOENT in the output is not a missing tool (PREREVIEW 6): an error that names no file', async () => {
    const r = await run({
      suites: [suite('lint', 'echo "Error: ENOENT: no such file or directory, open \'x.json\'"; exit 1')],
    });
    expect(r.evidence[0]?.status).toBe('error');
    expect(r.evidence[0]?.summary).toContain('without naming a file');
    const spawned = await run({ suites: [suite('lint', 'echo "Error: spawn biome ENOENT"; exit 1')] });
    expect(spawned.evidence[0]?.summary).toContain('missing tool');
  });

  it('output cut by the tool with no findings is incomplete (error); with findings in any file it fails; both block', async () => {
    const cutOnly = 'echo "Diagnostics not shown: 120."; exit 1';
    expect((await run({ suites: [suite('lint', cutOnly)] })).evidence[0]?.status).toBe('error');
    const cut = 'echo "src/b.ts:1:1 old"; echo "Diagnostics not shown: 120."; exit 1';
    expect((await run({ suites: [suite('lint', cut)] })).evidence[0]?.status).toBe('failed');
    const withMine = 'echo "src/a.ts:1:1 mine"; echo "Diagnostics not shown: 120."; exit 1';
    expect((await run({ suites: [suite('lint', withMine)] })).evidence[0]?.status).toBe('failed');
  });

  it('a timeout kills the process group and blocks', async () => {
    const s = setup();
    const marker = join(s.worktree, 'child-survived');
    const t0 = Date.now();
    const r = await runHandoffChecks({
      worktree: s.worktree,
      logDir: s.logDir,
      changedPaths: [],
      headSha: 'abcdef1234567890',
      launch: sh,
      budgetMs: 1600,
      suites: [suite('slow', `(sleep 4; touch ${marker}) & sleep 30`)],
    });
    expect(r.evidence[0]?.status).toBe('timeout');
    expect(r.blocking).toHaveLength(1);
    expect(r.refusal).toContain('"slow"');
    expect(Date.now() - t0).toBeLessThan(8000);
    await new Promise((res) => setTimeout(res, 4500));
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  it('a check after the budget is used up is not run', async () => {
    const r = await run({ budgetMs: 500, suites: [suite('late', 'echo x')] });
    expect(r.evidence[0]).toMatchObject({ status: 'error' });
    expect(r.evidence[0]?.summary).toContain('budget');
  });

  it('keeps at most 2 MiB of output and says so when it cannot judge', async () => {
    const r = await run({
      suites: [
        suite('big', 'yes "no file here" | head -c 3000000; exit 1', {
          cmd: ['sh', '-c', 'yes "no file here" | head -c 3000000; exit 1'],
        }),
      ],
    });
    expect(r.evidence[0]?.status).toBe('error');
    expect(r.evidence[0]?.summary).toContain('2 MiB');
    expect(r.blocking).toHaveLength(1);
  });

  it('without a launcher, or when it throws, the check is an error', async () => {
    const none = await run({ launch: undefined, suites: [suite('lint', 'true')] });
    expect(none.evidence[0]).toMatchObject({ status: 'error', summary: 'this runner cannot run checks' });
    const throws = await run({
      launch: async () => {
        throw new Error('the service sandbox (bubblewrap) is not available');
      },
      suites: [suite('lint', 'true')],
    });
    expect(throws.evidence[0]?.summary).toContain('bubblewrap');
  });

  it('the cache answers a repeated run at the same head, but never an error', async () => {
    const cache = new Map<string, { evidence: CheckEvidence; log: string }>();
    let launches = 0;
    const counting = async (argv: string[]) => {
      launches++;
      return sh(argv);
    };
    const s = setup();
    const input = {
      worktree: s.worktree,
      logDir: s.logDir,
      changedPaths: ['src/a.ts'],
      headSha: 'abcdef1234567890',
      launch: counting,
      cache,
    };
    await runHandoffChecks({ ...input, suites: [suite('lint', 'echo "src/a.ts:1:1 bad"; exit 1')] });
    const again = await runHandoffChecks({
      ...input,
      suites: [suite('lint', 'echo "src/a.ts:1:1 bad"; exit 1')],
    });
    expect(launches).toBe(1);
    expect(again.blocking).toHaveLength(1);
    await runHandoffChecks({ ...input, suites: [suite('e', 'exit 127')] });
    await runHandoffChecks({ ...input, suites: [suite('e', 'exit 127')] });
    expect(launches).toBe(3);
  });

  it('the cwd of the suite is used', async () => {
    const s = setup();
    const r = await runHandoffChecks({
      worktree: s.worktree,
      logDir: s.logDir,
      changedPaths: [],
      headSha: 'abcdef1234567890',
      launch: sh,
      suites: [suite('pwd', 'test "$(basename "$PWD")" = src', { cwd: 'src' })],
    });
    expect(r.evidence[0]?.status).toBe('passed');
  });
});
