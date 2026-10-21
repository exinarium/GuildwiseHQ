import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';

import { userInfo } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildShiftSettings } from '../src/adapters/claude-policy.ts';
import { createSandboxPlaceholders } from '../src/adapters/sandbox-placeholders.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox, sandboxEnv } from '../src/sandbox/sandbox.ts';
import { fakeApi, fakeServers } from './fake-claude-api.ts';
import { cleanupTmp } from './helpers.ts';
import { policyCtx } from './policy-fixtures.ts';

cleanupTmp();

/**
 * Runs the REAL Claude Code binary (its bundled sandbox runtime + bubblewrap) against a local fake Anthropic API that
 * asks for one Bash call, with the settings.json the runner generates for a role. No tokens are spent and nothing
 * leaves the machine. Skipped without `claude` and a working bubblewrap.
 *
 * The earlier "read-only worktree" fix was only unit tested on the settings (which mask paths), never against the real
 * sandbox, and the failure `bwrap: Can't create file <worktree>/.gitconfig: Read-only file system` stayed.
 */
const CLAUDE = [process.env.AOM_CLAUDE_BIN, join(userInfo().homedir, '.local', 'bin', 'claude')].find(
  (p): p is string => !!p && existsSync(p),
);
const bwrapOk =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { encoding: 'utf8' }).status === 0;
const enabled = CLAUDE !== undefined && bwrapOk;

const role = (key: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(key);
  return r;
};

const HOME_BASE = join(userInfo().homedir, '.aom-real-sandbox-test');

afterAll(() => {
  rmSync(HOME_BASE, { recursive: true, force: true });
  for (const s of fakeServers) s.close();
});

/** One real Claude Code `-p` run with the runner's generated settings; returns what the Bash tool printed. */
async function runBashAs(
  roleKey: string,
  command: string,
  opts: { cwdKind?: 'worktree' | 'scratch' } = {},
): Promise<{ output: string; stderr: string; settings: any; cwd: string }> {
  // Under the user's home, like the real data dir: the failure does not show with a root under /tmp.
  mkdirSync(HOME_BASE, { recursive: true });
  const root = realpathSync(mkdtempSync(join(HOME_BASE, 'r-')));
  const paths = runnerPaths(root);
  const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
  const sb = await ensureSandbox(paths, A, 'Ada');
  const cwd = opts.cwdKind === 'scratch' ? sb.scratch : join(root, 'worktrees', 'P-1', 'X-1');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, 'worktrees', 'P-1', 'X-2'), { recursive: true });
  mkdirSync(join(root, 'worktrees', 'P-9', 'Y-1'), { recursive: true });
  writeFileSync(join(root, 'config.json'), '{}');
  if (opts.cwdKind !== 'scratch') {
    spawnSync('git', ['init', '-q', '-b', 'main', cwd]);
    spawnSync('git', ['-C', cwd, 'commit', '-q', '--allow-empty', '-m', 'init'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'a',
        GIT_AUTHOR_EMAIL: 'a@b.c',
        GIT_COMMITTER_NAME: 'a',
        GIT_COMMITTER_EMAIL: 'a@b.c',
      },
    });
  }
  const p = role(roleKey).permissions;
  // what the adapter does before a read-only shift (AOM_REAL_NOFIX=1 shows the failure without it)
  const cleanup =
    roleKey !== 'builder' && !process.env.AOM_REAL_NOFIX ? createSandboxPlaceholders(cwd) : () => {};
  const settings = buildShiftSettings(
    p,
    policyCtx({
      runnerRoot: root,
      agentDir: paths.agentDir(A),
      cwd,
      gitDirs: [],
      aomReadPaths: [paths.bin],
      realHome: userInfo().homedir,
      sharedCacheDir: sb.cacheRoot,
    }),
    sb,
    roleKey,
  );
  mkdirSync(sb.configDir, { recursive: true });
  writeFileSync(join(sb.configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  writeFileSync(join(sb.configDir, 'mcp.json'), '{"mcpServers":{}}');
  const api = await fakeApi(command);
  const env: Record<string, string> = {
    PATH:
      (process.env.AOM_REAL_PATHPREFIX ? process.env.AOM_REAL_PATHPREFIX + ':' : '') +
      (process.env.PATH ?? ''),
    ...(process.env.BWRAP_LOG ? { BWRAP_LOG: process.env.BWRAP_LOG } : {}),
    ...sandboxEnv(sb),
    CLAUDE_CONFIG_DIR: sb.configDir,
    HOME: sb.home,
    CLAUDE_CODE_TMPDIR: sb.tmp,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'sk-ant-fake-fake-fake',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  const child = spawn(
    CLAUDE as string,
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
      ...(process.env.AOM_REAL_DEBUG ? ['--debug-file', process.env.AOM_REAL_DEBUG] : []),
    ],
    { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  await new Promise((r) => child.on('close', r));
  clearTimeout(timer);
  cleanup();
  return { output: api.results.join('\n'), stderr: stderr + stdout.slice(-1500), settings, cwd };
}

describe.skipIf(!enabled)(
  'real Claude Code sandbox with generated settings (skipped without claude + bwrap)',
  () => {
    it('builder: a Bash command runs in its worktree (control)', async () => {
      const r = await runBashAs('builder', 'echo PROBE-OK; pwd');
      expect(r.output, r.stderr).toContain('PROBE-OK');
    }, 120_000);

    it('reviewer (read-only worktree): a non-aom Bash command runs, no bwrap dotfile error, still read-only', async () => {
      const r = await runBashAs(
        'reviewer',
        'echo PROBE-OK; git log --oneline | head -1; touch NEWFILE 2>&1 | head -1; echo scratch > "$TMPDIR/x" && echo TMP-WRITE-OK',
      );
      expect(r.output, r.stderr).not.toContain("Can't create file");
      expect(r.output, r.stderr).toContain('PROBE-OK');
      expect(r.output, r.stderr).toContain('init');
      expect(r.output, r.stderr).toMatch(/NEWFILE.*(Read-only file system|Permission denied)/);
      expect(r.output, r.stderr).toContain('TMP-WRITE-OK');
      // the empty placeholders the runner made are gone again
      expect(existsSync(join(r.cwd, '.gitconfig'))).toBe(false);
    }, 120_000);
  },
);
