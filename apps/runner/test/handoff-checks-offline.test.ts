import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntegrationSuiteSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { detectUnitSuitesFromRef } from '../src/checks/detect.ts';
import { OFFLINE_ENV, offlineArgv, offlineEnv, TRUST_LOCKFILE_ENV } from '../src/checks/offline-env.ts';
import { RegressionUnits } from '../src/checks/regression-units.ts';
import { type CheckLaunch, checkOrder, runHandoffChecks } from '../src/checks/run.ts';
import { failingTestFiles, handoffUnitRuns, UNIT_FILES_MAX } from '../src/checks/units.ts';
import { runnerPaths } from '../src/paths.ts';
import { RunManager } from '../src/runs/manager.ts';
import { bwrapArgs, ServiceLauncher, sandboxCommand } from '../src/runs/sandbox.ts';
import { type GuardInput, mayEdit, ownerOf } from '../src/shifts/guard.ts';
import { offlineInstallProblem, prepareWorktree } from '../src/toolchain/prepare-worktree.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

cleanupTmp();

const REPO = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const check = (name: string, script: string, o: Record<string, unknown> = {}) =>
  IntegrationSuiteSchema.parse({ name, repoId: REPO, kind: 'check', cmd: ['sh', '-c', script], ...o });
const unit = (name: string, o: Record<string, unknown> = {}) =>
  IntegrationSuiteSchema.parse({ name, repoId: REPO, kind: 'unit', cmd: ['sh', '-c', 'exit 0'], ...o });
const plain = async (argv: string[]): Promise<CheckLaunch> => ({
  cmd: argv[0] as string,
  args: argv.slice(1),
  env: { PATH: process.env.PATH ?? '' },
});
const worktree = (files: string[] = ['src/a.ts', 'src/b.ts', 'e2e/login.spec.ts']) => {
  const wt = tmp('aom-off-wt-');
  for (const f of files) {
    mkdirSync(join(wt, f, '..'), { recursive: true });
    writeFileSync(join(wt, f), 'x\n');
  }
  return wt;
};
const base = (wt: string) => ({
  worktree: wt,
  logDir: join(tmp('aom-off-log-'), 'checks'),
  changedPaths: ['src/a.ts'],
  headSha: 'abcdef1234567890',
  launch: plain,
});
const guardInput = (roleKey: string, writableGlobs: string[] | null = null): GuardInput => ({
  worktree: '/x',
  roleKey,
  permissions: { mayCommit: true, writableGlobs },
  branchName: 'b',
  startSha: 'a',
  branchesAtStart: {} as GuardInput['branchesAtStart'],
  e2eGlobs: ['e2e/**'],
});

describe('offline package-manager environment', () => {
  it('sets both pnpm prefixes (pnpm 12 ignores npm_config_*), npm, yarn, corepack and python switches', () => {
    expect(OFFLINE_ENV).toMatchObject({
      pnpm_config_verify_deps_before_run: 'false',
      pnpm_config_offline: 'true',
      npm_config_verify_deps_before_run: 'false',
      npm_config_offline: 'true',
      npm_config_yes: 'false',
      YARN_ENABLE_NETWORK: '0',
      COREPACK_ENABLE_NETWORK: '0',
      UV_OFFLINE: '1',
      PIP_NO_INDEX: '1',
    });
    expect(TRUST_LOCKFILE_ENV).toEqual({
      pnpm_config_trust_lockfile: 'true',
      npm_config_trust_lockfile: 'true',
    });
  });

  it('points COREPACK_HOME at the real home cache only when it exists', () => {
    expect(offlineEnv('/home/u', () => true).COREPACK_HOME).toBe('/home/u/.cache/node/corepack');
    expect(offlineEnv('/home/u', () => false).COREPACK_HOME).toBeUndefined();
  });

  it('dotnet format gets --no-restore once; other commands are unchanged', () => {
    expect(offlineArgv(['dotnet', 'format', '--verify-no-changes'])).toEqual([
      'dotnet',
      'format',
      '--verify-no-changes',
      '--no-restore',
    ]);
    expect(offlineArgv(['dotnet', 'format', '--no-restore'])).toEqual(['dotnet', 'format', '--no-restore']);
    expect(offlineArgv(['pnpm', 'lint'])).toEqual(['pnpm', 'lint']);
  });

  it('the check sandbox can have a network namespace of its own; services keep the host network', () => {
    const spec = {
      runnerRoot: '/nonexistent-root',
      realHome: '/nonexistent-home',
      worktrees: [],
      cacheRoot: '/c',
      runTmp: '/t',
    };
    expect(bwrapArgs({ ...spec, network: 'none' })).toContain('--unshare-net');
    expect(bwrapArgs(spec)).not.toContain('--unshare-net');
    expect(bwrapArgs({ ...spec, network: 'host' })).not.toContain('--unshare-net');
  });

  it('the network namespace probe runs once and needs the sandbox', async () => {
    let probes = 0;
    const l = new ServiceLauncher({
      platform: 'linux',
      probeBwrap: async () => true,
      probeNetns: async () => {
        probes++;
        return false;
      },
    });
    expect(await l.networkIsolationAvailable()).toBe(false);
    expect(await l.networkIsolationAvailable()).toBe(false);
    expect(probes).toBe(1);
    const none = new ServiceLauncher({ platform: 'darwin', probeNetns: async () => true });
    expect(await none.networkIsolationAvailable()).toBe(false);
  });

  it('checkLaunch merges the offline environment, also unsandboxed, and keeps the argv offline', async () => {
    const mgr = new RunManager({
      paths: runnerPaths(tmp()),
      findRepo: async () => undefined,
      send: () => {},
      log: { info() {}, warn() {}, error() {} },
      maxEnvironments: () => 1,
      portRange: () => ({ from: 43000, to: 43010 }),
      realHome: '/nonexistent-home',
    });
    const l = await mgr.checkLaunch({ key: 'k', worktree: tmp(), argv: ['dotnet', 'format'] });
    expect(l.sandbox).toBe('off');
    expect(l.env).toMatchObject({ pnpm_config_offline: 'true', npm_config_offline: 'true', NO_COLOR: '1' });
    expect(l.args).toEqual(['format', '--no-restore']);
  });

  it('regression: a package manager that retries the network forever finishes fast under the check launch env', async () => {
    // a fake `pnpm` like pnpm 12: with pnpm_config_offline it fails at once, without it it retries the registry forever
    const bin = tmp('aom-fake-pnpm-');
    writeFileSync(
      join(bin, 'pnpm'),
      '#!/bin/sh\nif [ "$pnpm_config_offline" = "true" ]; then echo " ERR_PNPM_NO_OFFLINE_META  Failed to resolve @biomejs/biome"; exit 1; fi\necho "Verifying lockfile against supply-chain policies (664 entries)..."\nwhile true; do sleep 1; done\n',
    );
    chmodSync(join(bin, 'pnpm'), 0o755);
    const mgr = new RunManager({
      paths: runnerPaths(tmp()),
      findRepo: async () => undefined,
      send: () => {},
      log: { info() {}, warn() {}, error() {} },
      maxEnvironments: () => 1,
      portRange: () => ({ from: 43000, to: 43010 }),
      realHome: '/nonexistent-home',
      pathDirs: () => [bin],
    });
    const wt = worktree();
    const t0 = Date.now();
    const r = await runHandoffChecks({
      ...base(wt),
      suites: [check('lint', '', { cmd: ['pnpm', 'lint'], timeoutMin: 1 })],
      launch: (argv, key) => mgr.checkLaunch({ key, worktree: wt, argv }),
    });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.evidence[0]?.status).toBe('error');
    expect(r.blocking).toHaveLength(1);
    expect(r.refusal).toContain('ERR_PNPM_NO_OFFLINE_META');
  }, 20_000);

  const bwrap = spawnSync('bwrap', [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--unshare-net',
    'true',
  ]);
  it.skipIf(bwrap.status !== 0)(
    'regression (real bwrap): no network in the check sandbox, so a fetch fails fast',
    () => {
      const c = sandboxCommand(
        {
          runnerRoot: tmp(),
          realHome: '/nonexistent-home',
          worktrees: [],
          cacheRoot: tmp(),
          runTmp: tmp(),
          network: 'none',
        },
        [
          process.execPath,
          '-e',
          "require('node:net').connect(443, '1.1.1.1').on('error', (e) => { console.log(e.code); process.exit(3); }).on('connect', () => process.exit(0))",
        ],
      );
      const t0 = Date.now();
      const r = spawnSync(c.cmd, c.args, { encoding: 'utf8', timeout: 20_000 });
      expect(r.status).toBe(3);
      expect(r.stdout).toMatch(/ENETUNREACH|EAI_AGAIN|ECONNREFUSED/);
      expect(Date.now() - t0).toBeLessThan(5000);
    },
  );
});

describe('worktree preparation offline', () => {
  it('trusts the lockfile unless switched off, and names a package missing from the store plainly', async () => {
    const seen: Array<Record<string, string>> = [];
    const wt = worktree();
    sh(wt, 'git', ['init', '-q', '-b', 'main']);
    sh(wt, 'git', ['add', '-A']);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], {
      cwd: wt,
    });
    const stacks = () => [
      {
        id: 'node',
        steps: [
          {
            name: 'pnpm install',
            cmd: 'sh',
            args: [
              '-c',
              'env > env.out; echo " ERR_PNPM_NO_OFFLINE_TARBALL  A package is missing from the store but cannot download it in offline mode. The missing package may be downloaded from https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz."; exit 1',
            ],
          },
        ],
      },
    ];
    const launch = async (argv: string[]): Promise<CheckLaunch> => {
      const l = await plain(argv);
      return { ...l, env: { ...l.env, marker: '1' } };
    };
    const spawnImpl = ((cmd: string, args: string[], o: { env: Record<string, string> }) => {
      seen.push(o.env);
      return spawn(cmd, args, o as never);
    }) as never;
    const on = await prepareWorktree({
      worktree: wt,
      launch,
      platform: 'linux',
      stacks: stacks as never,
      spawnImpl,
    });
    expect(seen[0]).toMatchObject({ pnpm_config_trust_lockfile: 'true', CI: 'true' });
    const dep = on.steps.find((x) => x.name === 'pnpm install');
    expect(dep?.status).toBe('failed');
    expect(dep?.detail).toContain('not in the shared package store: left-pad');
    await prepareWorktree({
      worktree: wt,
      launch,
      platform: 'linux',
      stacks: stacks as never,
      spawnImpl,
      trustLockfile: false,
    });
    expect(seen[1]?.pnpm_config_trust_lockfile).toBeUndefined();
  });

  it('offlineInstallProblem: offline errors only', () => {
    expect(
      offlineInstallProblem('npm ERR! code ENOTCACHED request to https://registry.npmjs.org/foo failed'),
    ).toContain('foo');
    expect(
      offlineInstallProblem(' ERR_PNPM_NO_OFFLINE_META  Failed to resolve typescript@5 in package mirror'),
    ).toContain('typescript@5');
    expect(offlineInstallProblem('error TS2322')).toBeNull();
  });
});

describe('who may fix a finding (the guard scope)', () => {
  it('a builder may not edit E2E test content; a tester only E2E; a writer only its globs', () => {
    expect(mayEdit(guardInput('builder'), 'src/a.ts')).toBe(true);
    expect(mayEdit(guardInput('builder'), 'e2e/login.spec.ts')).toBe(false);
    expect(mayEdit(guardInput('tester'), 'e2e/login.spec.ts')).toBe(true);
    expect(mayEdit(guardInput('tester'), 'src/a.ts')).toBe(false);
    expect(mayEdit(guardInput('writer', ['docs/**', '**/*.md']), 'docs/x.md')).toBe(true);
    expect(mayEdit(guardInput('writer', ['docs/**', '**/*.md']), 'src/a.ts')).toBe(false);
    expect(mayEdit({ ...guardInput('builder'), permissions: { mayCommit: false } }, 'src/a.ts')).toBe(false);
    expect(ownerOf(['e2e/**'], 'e2e/login.spec.ts')).toBe('tester');
    expect(ownerOf(['e2e/**'], 'src/a.ts')).toBe('builder');
  });
});

describe('judging with the role scope', () => {
  const both = 'echo "src/b.ts:1:1 lint/style/useConst"; echo "e2e/login.spec.ts:2:1 lint/x"; exit 1';
  const e2eOnly = 'echo "e2e/login.spec.ts:2:1 lint/x"; exit 1';
  const scopeOf = (role: string, defer: boolean) => {
    const gi = guardInput(role);
    return { mayEdit: (p: string) => mayEdit(gi, p), ownerOf: (p: string) => ownerOf(gi.e2eGlobs, p), defer };
  };

  it('a builder: E2E-only findings are deferred, owed by the tester, and do not block', async () => {
    const r = await runHandoffChecks({
      ...base(worktree()),
      suites: [check('lint', e2eOnly)],
      scope: scopeOf('builder', true),
    });
    expect(r.evidence[0]).toMatchObject({
      status: 'deferred',
      owedBy: 'tester',
      owed: ['e2e/login.spec.ts:2:1 lint/x'],
    });
    expect(r.blocking).toEqual([]);
    expect(r.summary).toContain('owed by the tester');
  });

  it('a builder with its own finding too: refused for its own, the E2E one listed as owed (not blocking)', async () => {
    const r = await runHandoffChecks({
      ...base(worktree()),
      suites: [check('lint', both)],
      scope: scopeOf('builder', true),
    });
    expect(r.evidence[0]).toMatchObject({ status: 'failed', elsewhereCount: 1, owedCount: 1 });
    expect(r.refusal).toContain('In other files (1):\n  src/b.ts:1:1 lint/style/useConst');
    expect(r.refusal).toContain('Owed by the tester (does not block you, 1):');
  });

  it('an incomplete output with only E2E findings visible is never deferred: it blocks (B1)', async () => {
    const cut = 'echo "e2e/login.spec.ts:2:1 lint/x"; echo "Diagnostics not shown: 40."; exit 1';
    const r = await runHandoffChecks({
      ...base(worktree()),
      suites: [check('lint', cut)],
      scope: scopeOf('builder', true),
    });
    expect(r.evidence[0]?.status).toBe('failed');
    expect(r.evidence[0]?.summary).toContain('not deferred to the tester: the output is incomplete');
    expect(r.evidence[0]?.owed).toBeUndefined();
    expect(r.blocking).toHaveLength(1);
    expect(r.refusal).toContain('In other files (1):\n  e2e/login.spec.ts:2:1 lint/x');
  });

  it('a diagnostic that names no file of the repository is never deferred: it blocks (S4)', async () => {
    const odd = 'echo "e2e/login.spec.ts:2:1 lint/x"; echo "src/my file.ts:3:1 lint/y"; exit 1';
    const r = await runHandoffChecks({
      ...base(worktree()),
      suites: [check('lint', odd)],
      scope: scopeOf('builder', true),
    });
    expect(r.evidence[0]?.status).toBe('failed');
    expect(r.evidence[0]?.summary).toContain('1 diagnostic line name no file of the repository');
    expect(r.blocking).toHaveLength(1);
  });

  it('a code frame under an E2E finding (a URL with a port) is not an unmatched diagnostic: still deferred (R1)', async () => {
    const framed = [
      'echo "e2e/login.spec.ts:12:3 lint/style/noVar"',
      'echo "  > 12 │ await page.goto(\'http://127.0.0.1:3000/login\'); // see foo.ts:12"',
      'echo "    │   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^"',
      'echo "   13 │ await expect(page).toHaveURL("https://example.com:443/")"',
      'exit 1',
    ].join('; ');
    const r = await runHandoffChecks({
      ...base(worktree()),
      suites: [check('lint', framed)],
      scope: scopeOf('builder', true),
    });
    expect(r.evidence[0]).toMatchObject({ status: 'deferred', owedBy: 'tester' });
    expect(r.blocking).toEqual([]);
  });

  it('under pnpm -r a URL in an E2E code frame is not attributed or counted: still deferred (AC5)', async () => {
    const wt = worktree(['src/a.ts', 'src/b.ts', 'e2e/tests/x.spec.ts']);
    const framed = [
      'echo "e2e lint: tests/x.spec.ts:12:3 lint/x"',
      'echo "e2e lint:   > 12 | await page.goto(\'http://127.0.0.1:3000/src/a.ts\');"',
      'echo "e2e lint:      |        ^^^^^^^^^^"',
      'exit 1',
    ].join('; ');
    const r = await runHandoffChecks({
      ...base(wt),
      suites: [check('lint', framed)],
      scope: scopeOf('builder', true),
    });
    expect(r.evidence[0]).toMatchObject({ status: 'deferred', owedBy: 'tester' });
    expect(r.blocking).toEqual([]);
    expect(r.evidence[0]?.owed?.join('\n')).toContain('tests/x.spec.ts');
  });

  it('a real finding in a builder file still blocks with and without the pnpm -r prefix (AC6)', async () => {
    for (const mark of ['', 'apps/web lint: ']) {
      const wt = worktree(['src/a.ts', 'src/b.ts', 'e2e/tests/x.spec.ts']);
      const out = [
        'echo "e2e lint: tests/x.spec.ts:12:3 lint/x"',
        'echo "e2e lint:   > 12 | goto(\'https://example.com/x\')"',
        `echo "${mark}src/b.ts:1:1 lint/y"`,
        'exit 1',
      ].join('; ');
      const r = await runHandoffChecks({
        ...base(wt),
        suites: [check('lint', out)],
        scope: scopeOf('builder', true),
      });
      expect(r.evidence[0]?.status).toBe('failed');
      expect(r.blocking).toHaveLength(1);
      expect(r.refusal).toContain('src/b.ts');
    }
  });

  it('the checks use up the handoff deadline: the units are not run and say so (R2)', async () => {
    const r = await runHandoffChecks({
      ...base(worktree()),
      totalBudgetMs: 1500,
      suites: [check('lint', 'sleep 1')],
      units: [unit('shared', { cwd: '.', handoffCmd: ['sh', '-c', 'exit 0 #', '{files}'] })],
    });
    expect(r.evidence[1]).toMatchObject({ kind: 'unit', status: 'error' });
    expect(r.evidence[1]?.summary).toBe('not run: the handoff deadline was reached');
  }, 20_000);

  it('route folders with brackets and parentheses are attributed to their file', async () => {
    const wt = worktree(['src/routes/[id].tsx', 'src/(group)/page.tsx', 'e2e/login.spec.ts']);
    const r = await runHandoffChecks({
      ...base(wt),
      changedPaths: ['src/routes/[id].tsx'],
      suites: [
        check(
          'lint',
          'echo "src/routes/[id].tsx:1:1 x"; echo "src/(group)/page.tsx(2,3): error TS1"; exit 1',
        ),
      ],
      scope: scopeOf('builder', true),
    });
    expect(r.evidence[0]).toMatchObject({
      status: 'failed',
      introduced: ['src/routes/[id].tsx:1:1 x'],
      elsewhereCount: 1,
    });
  });

  it('a tester or writer is refused for a finding it may not edit, told who can fix it and how to report it', async () => {
    const r = await runHandoffChecks({
      ...base(worktree()),
      suites: [check('lint', 'echo "src/b.ts:1:1 lint/x"; exit 1')],
      scope: { ...scopeOf('tester', false), reportHint: 'Report it with `aom test fail`.' },
    });
    expect(r.evidence[0]).toMatchObject({ status: 'failed', owedBy: 'builder' });
    expect(r.blocking).toHaveLength(1);
    expect(r.refusal).toContain('Only a builder can fix these files');
    expect(r.refusal).toContain('Report it with `aom test fail`.');
  });

  it('checks run format, lint, typecheck; nothing confirmed is nothing to run (not a refusal)', async () => {
    const order: string[] = [];
    const r = await runHandoffChecks({
      ...base(worktree()),
      launch: async (argv) => {
        order.push(argv[2] as string);
        return plain(argv);
      },
      suites: [check('typecheck', 'echo tc'), check('lint', 'echo li'), check('format', 'echo fo')],
    });
    expect(order).toEqual(['echo fo', 'echo li', 'echo tc']);
    expect(r.blocking).toEqual([]);
    expect(checkOrder({ name: 'x', cmd: ['pnpm', '-r', 'typecheck'] })).toBe(2);
    const none = await runHandoffChecks({ ...base(worktree()), suites: [] });
    expect(none).toMatchObject({ evidence: [], blocking: [], refusal: '', summary: '' });
  });
});

describe('unit tests at a builder handoff', () => {
  it('maps changed files to the deepest suite folder, relative to it; deleted files and other folders are left out', () => {
    const shared = unit('shared', {
      cwd: 'packages/shared',
      handoffCmd: ['npx', 'vitest', 'related', '--run', '{files}'],
    });
    const root = unit('root', { cwd: '.', handoffCmd: ['npx', 'jest', '--findRelatedTests', '{files}'] });
    const noCmd = unit('server', { cwd: 'apps/server' });
    const exists = (p: string) => p !== 'packages/shared/src/gone.ts';
    const runs = handoffUnitRuns(
      [shared, root, noCmd],
      [
        'packages/shared/src/a.ts',
        'packages/shared/test/a.test.ts',
        'packages/shared/src/gone.ts',
        'tools/x.ts',
        'apps/server/src/s.ts',
      ],
      exists,
    );
    expect(runs.map((r) => [r.suite.name, r.argv])).toEqual([
      ['shared', ['npx', 'vitest', 'related', '--run', 'src/a.ts', 'test/a.test.ts']],
      ['root', ['npx', 'jest', '--findRelatedTests', 'tools/x.ts', 'apps/server/src/s.ts']],
    ]);
    expect(handoffUnitRuns([shared], ['README.md'], () => true)).toEqual([]);
  });

  it('{files} must be an argument of its own (else the whole suite runs); a file named like an option is given as ./-name', () => {
    const embedded = unit('e', { cmd: ['pnpm', 'test'], handoffCmd: ['sh', '-c', 'vitest related {files}'] });
    expect(handoffUnitRuns([embedded], ['a.ts'], () => true)[0]).toMatchObject({
      whole: true,
      argv: ['pnpm', 'test'],
    });
    const own = unit('o', { handoffCmd: ['npx', 'vitest', 'related', '{files}'] });
    expect(handoffUnitRuns([own], ['-x.ts', 'b c.ts'], () => true)[0]?.argv).toEqual([
      'npx',
      'vitest',
      'related',
      './-x.ts',
      'b c.ts',
    ]);
  });

  it(`more than ${UNIT_FILES_MAX} files run the whole suite`, () => {
    const u = unit('w', { cmd: ['pnpm', 'test'], handoffCmd: ['x', '{files}'] });
    const many = Array.from({ length: UNIT_FILES_MAX + 1 }, (_, i) => `f${i}.ts`);
    expect(handoffUnitRuns([u], many, () => true)[0]).toMatchObject({ whole: true, argv: ['pnpm', 'test'] });
  });

  it('reads the failing test files of vitest and jest output', () => {
    expect(
      failingTestFiles(' FAIL  test/a.test.ts > x > y\n FAIL  test/a.test.ts > z\nFAIL src/b.spec.tsx\n'),
    ).toEqual(['test/a.test.ts', 'src/b.spec.tsx']);
  });

  const unitRun = (script: string, o: Record<string, unknown> = {}) =>
    unit('shared', { cwd: '.', handoffCmd: ['sh', '-c', `${script} #`, '{files}'], ...o });

  it('judging: a failing test refuses with the file, a timeout and an error refuse, a pass passes, no command is regression only', async () => {
    const pass = await runHandoffChecks({ ...base(worktree()), suites: [], units: [unitRun('exit 0')] });
    expect(pass.evidence[0]).toMatchObject({ kind: 'unit', status: 'passed' });
    expect(pass.blocking).toEqual([]);

    const fail = await runHandoffChecks({
      ...base(worktree()),
      suites: [],
      units: [unitRun('echo " FAIL  src/a.test.ts > adds"; echo "Tests  1 failed"; exit 1')],
    });
    expect(fail.evidence[0]).toMatchObject({
      kind: 'unit',
      status: 'failed',
      introduced: ['FAIL src/a.test.ts'],
    });
    expect(fail.refusal).toContain('the unit tests "shared"');

    const slow = await runHandoffChecks({
      ...base(worktree()),
      suites: [],
      unitBudgetMs: 1500,
      units: [unitRun('sleep 20')],
    });
    expect(slow.evidence[0]).toMatchObject({ kind: 'unit', status: 'timeout' });
    expect(slow.blocking).toHaveLength(1);

    const missing = await runHandoffChecks({ ...base(worktree()), suites: [], units: [unitRun('exit 127')] });
    expect(missing.evidence[0]).toMatchObject({ status: 'error' });

    const later = await runHandoffChecks({
      ...base(worktree()),
      suites: [],
      units: [unit('server', { cwd: 'apps/server' })],
    });
    expect(later.evidence[0]).toMatchObject({ kind: 'unit', status: 'regression_only' });
    expect(later.blocking).toEqual([]);
    expect(later.summary).toContain('not run at handoff (runs at regression)');
  }, 20_000);

  it('the checks and the unit runs together stay inside the total budget', async () => {
    const t0 = Date.now();
    const r = await runHandoffChecks({
      ...base(worktree()),
      totalBudgetMs: 2500,
      suites: [check('lint', 'sleep 1')],
      units: [unitRun('sleep 20')],
    });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.evidence.map((e) => e.status)).toEqual(['passed', 'timeout']);
    expect(r.evidence[1]?.summary).toContain('budget for these runs ran out');
  }, 20_000);

  it('a handoff that changed no file of a unit suite runs nothing for it', async () => {
    const r = await runHandoffChecks({
      ...base(worktree()),
      changedPaths: ['README.md'],
      suites: [],
      units: [unit('shared', { cwd: 'src', handoffCmd: ['sh', '-c', 'exit 1', '{files}'] })],
    });
    expect(r.evidence).toEqual([]);
  });
});

describe('unit suite proposals', () => {
  it('one per package with a test script; a related-tests handoff command only for vitest and jest', async () => {
    const wt = tmp('aom-unit-detect-');
    sh(wt, 'git', ['init', '-q', '-b', 'main']);
    const pkg = (dir: string, scripts: Record<string, string>) => {
      mkdirSync(join(wt, dir), { recursive: true });
      writeFileSync(join(wt, dir, 'package.json'), JSON.stringify({ scripts }));
    };
    pkg('.', { test: 'pnpm -r test' });
    pkg('packages/shared', { test: 'vitest run' });
    pkg('apps/web', { 'test:unit': 'jest', test: 'playwright test' });
    pkg('apps/other', { test: 'mocha' });
    pkg('apps/none', { build: 'tsc' });
    writeFileSync(join(wt, 'pnpm-lock.yaml'), '');
    sh(wt, 'git', ['add', '-A']);
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], {
      cwd: wt,
    });
    const p = await detectUnitSuitesFromRef(wt, 'HEAD');
    expect(p.map((x) => [x.name, x.cmd, x.handoffCmd?.[1]])).toEqual([
      ['unit apps/other', ['pnpm', 'test'], undefined],
      ['unit apps/web', ['pnpm', 'test:unit'], 'jest'],
      ['unit packages/shared', ['pnpm', 'test'], 'vitest'],
    ]);
    expect(p.every((x) => x.kind === 'unit')).toBe(true);
  });
});

describe('unit suites on a suite card', () => {
  it('runs each suite whole, reports it as measured, refuses a pass while running or failed, and files a bug section per failing file', async () => {
    const wt = worktree();
    const reports: unknown[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const units = new RegressionUnits({
      suites: [
        unit('shared', {
          cmd: ['sh', '-c', 'echo " FAIL  test/a.test.ts > x"; echo " FAIL  test/b.test.ts > y"; exit 1'],
          cwd: 'src',
        }),
        unit('web', { cmd: ['sh', '-c', 'exit 0'] }),
      ],
      worktree: wt,
      logDir: join(tmp(), 'checks'),
      launch: async (argv) => {
        await gate;
        return plain(argv);
      },
      report: async (r) => {
        reports.push(r);
      },
    });
    expect(units.isUnitSuite('Shared')).toBe(true);
    const done = units.start();
    expect(units.passProblem()).toContain('still running the unit suites');
    release();
    await done;
    expect(reports).toEqual([
      expect.objectContaining({
        name: 'shared',
        status: 'failed',
        kind: 'unit',
        measured: true,
        failures: ['src/test/a.test.ts', 'src/test/b.test.ts'],
      }),
      expect.objectContaining({ name: 'web', status: 'passed', kind: 'unit', measured: true }),
    ]);
    expect(units.passProblem()).toContain('report it with `aom test fail`');
    const sections = units.failSections();
    expect(sections).toContain(
      'Bug: Unit tests fail in src/test/a.test.ts (shared)\nTest: unit:shared:src/test/a.test.ts',
    );
    expect(sections).toContain('Test: unit:shared:src/test/b.test.ts');
    expect(sections).not.toContain('web');
  });

  it('every suite passed: the pass is allowed and there is no bug section', async () => {
    const units = new RegressionUnits({
      suites: [unit('web')],
      worktree: worktree(),
      logDir: join(tmp(), 'checks'),
      launch: plain,
      report: async () => {},
    });
    await units.start();
    expect(units.passProblem()).toBeNull();
    expect(units.failSections()).toBe('');
  });
});
