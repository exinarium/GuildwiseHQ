import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { addInstallRedirect } from '../../../apps/runner/src/adapters/claude-code.ts';
import { buildShiftSettings, gitDirsOf } from '../../../apps/runner/src/adapters/claude-policy.ts';
import { computeCardDiff } from '../../../apps/runner/src/git/card-diff.ts';
import { runnerPaths } from '../../../apps/runner/src/paths.ts';
import { ensureSandbox, sandboxEnv } from '../../../apps/runner/src/sandbox/sandbox.ts';
import { autoCommit, uncommittedFiles } from '../../../apps/runner/src/shifts/autocommit.ts';
import { runGuard, snapshotBranches, snapshotDirty } from '../../../apps/runner/src/shifts/guard.ts';
import { fakeApi, fakeServers } from '../../../apps/runner/test/fake-claude-api.ts';
import { policyCtx } from '../../../apps/runner/test/policy-fixtures.ts';
import { BUILTIN_ROLES } from '../../../packages/shared/src/index.ts';
import { PLACEHOLDERS } from '../support/scenario-adapter.ts';

// A7 lane 2: the REAL `claude` in its REAL sandbox (bwrap) against a fake Anthropic API on 127.0.0.1, with the settings the
// runner generates for an architect. It shows what Claude's own sandbox leaves in a writable worktree on this machine's
// Claude version, then runs the product's own guard, auto-commit and diff on that worktree. NOT end-to-end: no Runner, no
// server. `claude` is started DIRECTLY with an explicit environment (never through ClaudeCodeAdapter, which would copy
// the owner's Claude login and reach the real API): a guard below refuses to start it if any credential is visible.

const CLAUDE = [process.env.AOM_CLAUDE_BIN, join(homedir(), '.local', 'bin', 'claude')].find(
  (p): p is string => !!p && existsSync(p),
);
const bwrapOk = spawnSync('bwrap', ['--unshare-all', '--ro-bind', '/', '/', 'true']).status === 0;
const TOOLS = process.env.AOM_COMBINED_TOOLS;
const DUMMY_KEY = 'sk-ant-fake-fake-fake';

test.afterAll(() => {
  for (const s of fakeServers) s.close();
});

/** Refuses (throws) when the environment or the folders the child would see could carry a real credential. */
export function assertNoCredentials(env: Record<string, string>, laneRoot: string, realHome: string): void {
  const allowedClaude = new Set([
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_TMPDIR',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  ]);
  for (const k of Object.keys(env)) {
    if (
      /^(CLAUDE|ANTHROPIC)/.test(k) &&
      !allowedClaude.has(k) &&
      k !== 'ANTHROPIC_BASE_URL' &&
      k !== 'ANTHROPIC_API_KEY'
    )
      throw new Error(`lane 2 refuses to start: credential-like variable ${k} is in the child environment`);
    if (/^(AWS_|GOOGLE_|GCP_|GH_|GITHUB_|OPENAI_|AZURE_|VERTEX|NPM_TOKEN|SSH_AUTH_SOCK|GIT_ASKPASS)/.test(k))
      throw new Error(`lane 2 refuses to start: credential-like variable ${k} is in the child environment`);
  }
  if (env.ANTHROPIC_API_KEY !== DUMMY_KEY)
    throw new Error('lane 2 refuses to start: ANTHROPIC_API_KEY is not the dummy');
  if (new URL(env.ANTHROPIC_BASE_URL ?? 'http://x').hostname !== '127.0.0.1')
    throw new Error('lane 2 refuses to start: ANTHROPIC_BASE_URL is not 127.0.0.1');
  for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
    const v = env[k];
    if (!v) continue;
    if (
      !realpathSync(v).startsWith(`${realpathSync(laneRoot)}/`) &&
      realpathSync(v) !== realpathSync(laneRoot)
    )
      throw new Error(`lane 2 refuses to start: ${k} is outside the lane root`);
    if (realpathSync(v) === realpathSync(realHome))
      throw new Error(`lane 2 refuses to start: ${k} is the real home`);
    for (const f of ['.credentials.json', '.claude.json', '.config/claude']) {
      if (existsSync(join(v, f))) throw new Error(`lane 2 refuses to start: ${join(v, f)} exists`);
    }
  }
  for (const p of (env.PATH ?? '').split(':'))
    if (p && (p === join(realHome, '.claude') || p.startsWith(`${join(realHome, '.claude')}/`)))
      throw new Error('lane 2 refuses to start: PATH names a folder of the real Claude login');
}

test('[A7-L2] real claude + real bwrap: the stubs its sandbox leaves in an architect worktree are not work (guard, WIP commit, diff)', async () => {
  if (!CLAUDE || !bwrapOk || !TOOLS) {
    test.info().annotations.push({
      type: 'owner-machine',
      description: `no claude binary, no working bwrap or no ~/.aom-combined-tools folder here (claude=${CLAUDE ?? 'none'}, bwrap=${bwrapOk})`,
    });
    test.skip(true, 'real-sandbox lane needs claude and bwrap');
    return;
  }
  const laneRoot = realpathSync(TOOLS);
  const root = join(laneRoot, 'lane2');
  const paths = runnerPaths(root);
  const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
  const sb = await ensureSandbox(paths, A, 'Ada');
  const cwd = join(root, 'worktrees', 'P-1', 'X-1');
  writeFileSync(join(root, 'config.json'), '{}');
  const id = {
    GIT_AUTHOR_NAME: 'a',
    GIT_AUTHOR_EMAIL: 'a@b.c',
    GIT_COMMITTER_NAME: 'a',
    GIT_COMMITTER_EMAIL: 'a@b.c',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...a: string[]) =>
    spawnSync('git', ['-C', cwd, ...a], { env: { ...process.env, ...id }, encoding: 'utf8' });
  // a LINKED worktree of a repository, as the runner makes for a card (the sandbox treats `.git` of a plain repo differently)
  const repo = join(root, 'repos', 'P-1');
  mkdirSync(repo, { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', repo], { env: { ...process.env, ...id } });
  spawnSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], {
    env: { ...process.env, ...id },
  });
  mkdirSync(join(root, 'worktrees', 'P-1'), { recursive: true });
  spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'aom/l2-x', cwd], {
    env: { ...process.env, ...id },
  });
  const role = BUILTIN_ROLES.find((r) => r.key === 'architect');
  if (!role) throw new Error('no architect role');
  const settings = buildShiftSettings(
    role.permissions,
    policyCtx({
      runnerRoot: root,
      agentDir: paths.agentDir(A),
      cwd,
      gitDirs: gitDirsOf(cwd),
      aomReadPaths: [paths.bin],
      realHome: homedir(),
      sharedCacheDir: sb.cacheRoot,
    }),
    sb,
    'architect',
  );
  addInstallRedirect(settings);
  mkdirSync(sb.configDir, { recursive: true });
  writeFileSync(join(sb.configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  writeFileSync(join(sb.configDir, 'mcp.json'), '{"mcpServers":{}}');
  const api = await fakeApi('echo PROBE-OK; pwd');
  const base: Record<string, string> = { PATH: process.env.PATH ?? '', ...sandboxEnv(sb) };
  const env: Record<string, string> = {
    ...base,
    CLAUDE_CONFIG_DIR: sb.configDir,
    HOME: sb.home,
    CLAUDE_CODE_TMPDIR: sb.tmp,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: DUMMY_KEY,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
  };
  // the guard: nothing that could be a real login is visible to the child (throws, naming the variable or path)
  assertNoCredentials(env, laneRoot, homedir());

  const startSha = git('rev-parse', 'HEAD').stdout.trim();
  const branchesAtStart = await snapshotBranches(cwd);
  const dirtyAtStart = await snapshotDirty(cwd);
  const child = spawn(
    CLAUDE,
    [
      '-p',
      'run the probe',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-opus-5-5',
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      'user',
      '--strict-mcp-config',
      '--mcp-config',
      join(sb.configDir, 'mcp.json'),
    ],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  await new Promise((r) => child.on('close', r));
  clearTimeout(timer);
  expect(api.results.join('\n'), out.slice(-800)).toContain('PROBE-OK'); // the fake API was reached and the sandbox ran the command

  const version = spawnSync(CLAUDE, ['--version'], {
    env: { PATH: process.env.PATH ?? '', HOME: sb.home },
    encoding: 'utf8',
  }).stdout.trim();
  const present = readdirSync(cwd).filter(
    (n) =>
      (PLACEHOLDERS as readonly string[]).includes(n) &&
      lstatSync(join(cwd, n)).isFile() &&
      lstatSync(join(cwd, n)).size === 0,
  );
  test.info().annotations.push({
    type: 'claude-version',
    description: `${version}; empty stubs seen: ${present.join(',') || 'none'}`,
  });
  expect(
    present.length,
    `claude ${version} made no stubs in ${cwd}: the check proves nothing about the stub shape (report it)`,
  ).toBeGreaterThan(0);

  // what the architect then does: a docs report; the runner's own checks on that worktree
  mkdirSync(join(cwd, 'docs', 'investigations'), { recursive: true });
  writeFileSync(join(cwd, 'docs', 'investigations', 'L2.md'), '# L2\n\n## Design\nreal sandbox lane\n');
  const violations = await runGuard({
    worktree: cwd,
    roleKey: 'architect',
    permissions: role.permissions,
    branchName: 'aom/l2-x',
    startSha,
    branchesAtStart,
    dirtyAtStart,
    e2eGlobs: ['e2e/**'],
    baseBranch: 'main',
  });
  expect(violations.map((v) => v.rule)).not.toContain('architect_edited_non_docs');
  expect(violations).toEqual([]);
  expect(await uncommittedFiles(cwd)).toEqual(['?? docs/investigations/L2.md']);
  const wip = await autoCommit({
    worktree: cwd,
    ticket: 'L2',
    env: { ...process.env, ...id } as Record<string, string>,
  });
  expect(wip.committed).toBe(true);
  const tracked = git('ls-tree', '-r', '--name-only', 'HEAD').stdout.split('\n').filter(Boolean);
  expect(tracked).toEqual(['docs/investigations/L2.md']);
  const diff = JSON.stringify(await computeCardDiff(cwd, 'main'));
  for (const p of PLACEHOLDERS) expect(diff).not.toMatch(new RegExp(`["/ ]${p.replace('.', '\\.')}["/\\s]`));
});

test('lane 2 credential guard: refuses a visible login', () => {
  const root = TOOLS ?? '/tmp';
  const ok: Record<string, string> = {
    PATH: '/usr/bin',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    ANTHROPIC_API_KEY: DUMMY_KEY,
  };
  expect(() => assertNoCredentials(ok, root, '/home/x')).not.toThrow();
  for (const bad of [
    { CLAUDE_CODE_OAUTH_TOKEN: 'x' },
    { ANTHROPIC_AUTH_TOKEN: 'x' },
    { AWS_ACCESS_KEY_ID: 'x' },
    { GITHUB_TOKEN: 'x' },
    { ANTHROPIC_API_KEY: 'sk-ant-real' },
    { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
  ])
    expect(
      () => assertNoCredentials({ ...ok, ...bad } as unknown as Record<string, string>, root, '/home/x'),
      JSON.stringify(Object.keys(bad)),
    ).toThrow(/refuses to start/);
});
