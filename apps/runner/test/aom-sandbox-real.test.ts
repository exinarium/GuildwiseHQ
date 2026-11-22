import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES, type IpcRpcRequest } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildShiftSettings, gitDirsOf } from '../src/adapters/claude-policy.ts';
import { createSandboxPlaceholders } from '../src/adapters/sandbox-placeholders.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox, sandboxEnv } from '../src/sandbox/sandbox.ts';
import { issueShiftCredential, sessionEnvDirOf } from '../src/session/shift-credential.ts';
import { startApprovalsWindow } from '../src/window/server.ts';
import { fakeApi, fakeServers } from './fake-claude-api.ts';
import { cleanupTmp } from './helpers.ts';
import { policyCtx } from './policy-fixtures.ts';
import { makeEnv } from './window-helpers.ts';

cleanupTmp();

/**
 * The 1.10.0 UAT blocker: an agent's standalone `aom ceo snapshot` failed inside the Linux sandbox with EPERM on the
 * loopback endpoint. Runs the REAL Claude Code binary (its bundled sandbox runtime + bubblewrap) against a local fake
 * Anthropic API that asks for one Bash call, with the settings.json the runner generates for the role, a real IPC server
 * (TCP + Unix socket), the real `bin/aom` shim and the session env file, scrub on (the 1.10.0 default). No tokens are
 * spent. Skipped without `claude` and a working bubblewrap.
 */
const CLAUDE = [process.env.AOM_CLAUDE_BIN, join(userInfo().homedir, '.local', 'bin', 'claude')].find(
  (p): p is string => !!p && existsSync(p),
);
const bwrapOk =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { encoding: 'utf8' }).status === 0;
const enabled = CLAUDE !== undefined && bwrapOk;

const HOME_BASE = join(userInfo().homedir, '.aom-real-aom-sandbox-test');
const ipc = new IpcServer();

/** `dist/aom.mjs` as the release builds it (tsup.config.ts): from source, `tsx` itself needs a Unix socket. */
const BUNDLE_DIR = join(HOME_BASE, 'dist');
const AOM_BUNDLE = join(BUNDLE_DIR, 'aom.mjs');

beforeAll(async () => {
  if (!enabled) return;
  const req = createRequire(createRequire(import.meta.url).resolve('tsup'));
  // tsup's own esbuild (not a direct dependency of the runner)
  const esbuild = req('esbuild') as { build(o: Record<string, unknown>): Promise<unknown> };
  mkdirSync(BUNDLE_DIR, { recursive: true });
  await esbuild.build({
    entryPoints: [join(import.meta.dirname, '..', 'src', 'aom', 'aom-cli.ts')],
    outfile: AOM_BUNDLE,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    define: { __AOM_RUNNER_RELEASE_PUBKEY__: '""' },
    banner: {
      js: "import { createRequire as __aomCreateRequire } from 'node:module'; const require = __aomCreateRequire(import.meta.url);",
    },
    logLevel: 'error',
  });
  await ipc.start();
  await ipc.startSocket();
});

afterAll(async () => {
  rmSync(HOME_BASE, { recursive: true, force: true });
  for (const s of fakeServers) s.close();
  await ipc.stop();
});

async function runAomAs(
  roleKey: string,
  command: string,
): Promise<{ output: string; stderr: string; calls: IpcRpcRequest[] }> {
  mkdirSync(HOME_BASE, { recursive: true });
  const root = realpathSync(mkdtempSync(join(HOME_BASE, 'r-')));
  const paths = runnerPaths(root);
  // the shim writeShims makes for a bundled runner
  mkdirSync(paths.bin, { recursive: true });
  writeFileSync(join(paths.bin, 'aom'), `#!/bin/sh\nexec "${process.execPath}" "${AOM_BUNDLE}" "$@"\n`);
  chmodSync(join(paths.bin, 'aom'), 0o755);
  const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
  const sb = await ensureSandbox(paths, A, 'Ada');
  const ceo = roleKey === 'ceo';
  const cwd = ceo ? sb.scratch : join(root, 'worktrees', 'P-1', 'X-1');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(root, 'config.json'), '{}');
  if (!ceo) {
    const repo = join(root, 'repos', 'P-1');
    mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'package.json'), '{"name":"probe","version":"1.0.0","private":true}\n');
    spawnSync('git', ['-C', repo, 'add', '-A']);
    spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'a',
        GIT_AUTHOR_EMAIL: 'a@b.c',
        GIT_COMMITTER_NAME: 'a',
        GIT_COMMITTER_EMAIL: 'a@b.c',
      },
    });
    rmSync(cwd, { recursive: true, force: true });
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'X-1', cwd]);
  }
  const seen: IpcRpcRequest[] = [];
  const cred = issueShiftCredential(
    { ipc, runnerRoot: root },
    {
      sessionId: `real-${roleKey}`,
      handler: {
        report: async () => ({ status: 501, error: 'n/a' }),
        rpc: async (req) => {
          seen.push(req);
          return { ok: true, result: { message: `RUNNER-ANSWERED ${req.method}` } };
        },
      },
    },
  );
  const role = BUILTIN_ROLES.find((x) => x.key === roleKey);
  if (!role) throw new Error(roleKey);
  const cleanup = ceo ? () => {} : createSandboxPlaceholders(cwd);
  const sessionEnvDir = sessionEnvDirOf(cred.env.AOM_SHIFT_ENV_FILE, root);
  const settings = buildShiftSettings(
    role.permissions,
    policyCtx({
      runnerRoot: root,
      agentDir: paths.agentDir(A),
      cwd,
      gitDirs: ceo ? [] : gitDirsOf(cwd),
      aomReadPaths: [paths.bin, BUNDLE_DIR],
      realHome: userInfo().homedir,
      sharedCacheDir: sb.cacheRoot,
      ...(sessionEnvDir ? { sessionEnvDir } : {}),
      ...(cred.env.AOM_IPC_SOCKET ? { ipcSocket: cred.env.AOM_IPC_SOCKET } : {}),
      // what the adapter passes (claude-code.ts policy()); AOM_REAL_NOFIX=1 leaves it out and shows the 1.10.0 failure
      ...(process.env.AOM_REAL_NOFIX ? {} : { ipcUrl: cred.env.AOM_IPC_URL }),
    }),
    sb,
    roleKey,
  );
  mkdirSync(sb.configDir, { recursive: true });
  writeFileSync(join(sb.configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  writeFileSync(join(sb.configDir, 'mcp.json'), '{"mcpServers":{}}');
  const api = await fakeApi(command);
  const env: Record<string, string> = {
    PATH: `${paths.bin}:${process.env.PATH ?? ''}`,
    ...sandboxEnv(sb),
    ...cred.env,
    CLAUDE_CONFIG_DIR: sb.configDir,
    HOME: sb.home,
    CLAUDE_CODE_TMPDIR: sb.tmp,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'sk-ant-fake-fake-fake',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    // what sessionEnv adds for every sandboxed role (`scrubSubprocessEnv`, on by default since 1.10.0): with it Claude
    // Code runs EVERY Bash call in the sandbox, `aom` too, whatever `excludedCommands` says
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
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
  cred.revoke();
  return { output: api.results.join('\n'), stderr: stderr + stdout.slice(-1500), calls: seen };
}

/** Every built-in role whose sessions have a shell (the others have no Bash tool to run `aom` in), and the CEO. */
const SHELL_ROLES = BUILTIN_ROLES.filter(
  (r) => r.key !== 'devops' && r.permissions.allowedTools.includes('shell'),
).map((r) => r.key);

describe.skipIf(!enabled)(
  'real Claude Code sandbox, scrub on: aom reaches the runner from every role (skipped without claude + bwrap)',
  () => {
    it('covers the CEO and the roles that build, review and test', () => {
      for (const k of ['ceo', 'builder', 'reviewer', 'tester', 'architect', 'ba'])
        expect(SHELL_ROLES).toContain(k);
    });

    it.each(SHELL_ROLES)(
      '%s: `aom ceo snapshot` (a read call) reaches the runner',
      async (roleKey) => {
        const r = await runAomAs(roleKey, 'aom ceo snapshot');
        expect(r.output, r.stderr).toContain('RUNNER-ANSWERED ceo');
        expect(r.calls.map((c) => c.method)).toEqual(['ceo']);
      },
      120_000,
    );

    it.each(SHELL_ROLES)(
      '%s: `aom devops install npm` reaches the runner',
      async (roleKey) => {
        const r = await runAomAs(roleKey, 'aom devops install npm');
        expect(r.output, r.stderr).toContain('RUNNER-ANSWERED devops.install');
        expect(r.calls).toEqual([
          { method: 'devops.install', params: { tool: 'npm', action: 'install', packages: [], dev: false } },
        ]);
      },
      120_000,
    );

    it('the sandbox still refuses any other loopback port (only the runner endpoint is open)', async () => {
      const r = await runAomAs(
        'builder',
        'curl -sS -m 5 --noproxy "" -x "$HTTP_PROXY" http://127.0.0.1:9/ ; echo PROBE-DONE',
      );
      expect(r.output, r.stderr).toContain('PROBE-DONE');
      expect(r.output, r.stderr).toMatch(/blocked by network allowlist|403/);
      expect(r.calls).toEqual([]);
    }, 120_000);

    it('a sandboxed shift cannot reach the approvals page port (DESIGN "Reach versus use" [B3])', async () => {
      const e = await makeEnv();
      const w = await startApprovalsWindow(e.deps);
      try {
        expect(w.windowError).toBeUndefined();
        const r = await runAomAs(
          'builder',
          `curl -sS -m 5 --noproxy "" -x "$HTTP_PROXY" http://127.0.0.1:${w.port}/api/hello ; curl -sS -m 5 http://127.0.0.1:${w.port}/api/hello ; echo PROBE-DONE`,
        );
        expect(r.output, r.stderr).toContain('PROBE-DONE');
        expect(r.output, r.stderr).not.toContain('"instance"');
        expect(r.output, r.stderr).toMatch(
          /blocked by network allowlist|403|Failed to connect|Couldn't connect/,
        );
      } finally {
        await w.close();
      }
    }, 120_000);
  },
);
