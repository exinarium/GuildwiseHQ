import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildShiftSettings } from '../src/adapters/claude-policy.ts';
import { runnerPaths } from '../src/paths.ts';
import { ensureSandbox, sandboxEnv } from '../src/sandbox/sandbox.ts';
import { fakeApi, fakeServers } from './fake-claude-api.ts';
import { cleanupTmp } from './helpers.ts';
import { policyCtx } from './policy-fixtures.ts';

cleanupTmp();

/**
 * The "Scan with DevOps" sandbox against the REAL bubblewrap, driven by the real Claude Code binary (its bundled
 * sandbox runtime builds the bwrap arguments from the generated settings) and a fake local Anthropic API that asks for one
 * Bash call. Everything lives under a temporary fake home: the real home, `~/.ssh` and `~/.config` are never touched and
 * nothing leaves the machine. Skipped only when bubblewrap (or the `claude` binary that drives it) is missing.
 */
const CLAUDE = [process.env.AOM_CLAUDE_BIN, join(userInfo().homedir, '.local', 'bin', 'claude')].find(
  (p): p is string => !!p && existsSync(p),
);
const bwrapOk =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { encoding: 'utf8' }).status === 0;
const enabled = CLAUDE !== undefined && bwrapOk;

const bases: string[] = [];
afterAll(() => {
  for (const b of bases) rmSync(b, { recursive: true, force: true });
  for (const s of fakeServers) s.close();
});

const devops = BUILTIN_ROLES.find((r) => r.key === 'devops');

interface Layout {
  home: string;
  checkout: string;
  outside: string;
}

/** A fake home with a checkout OUTSIDE the runner's data folder, secrets in and around it. */
function layout(): Layout & { root: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'aom-scan-real-')));
  bases.push(base);
  const home = join(base, 'home');
  const checkout = join(home, 'src', 'proj');
  const outside = join(home, '.config', 'aom-uat');
  for (const d of [
    join(checkout, 'src'),
    join(checkout, 'build'),
    join(checkout, 'dist', 'deep'),
    join(checkout, 'node_modules', 'pkg'),
    join(checkout, '.git'),
    outside,
    join(home, '.ssh'),
    join(home, '.aom-runner'),
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(checkout, 'src', 'app.ts'), 'NORMAL-SOURCE\n');
  writeFileSync(join(checkout, '.env'), 'SECRET-DOTENV\n');
  writeFileSync(join(checkout, 'build', '.env'), 'SECRET-BUILD-ENV\n');
  writeFileSync(join(checkout, 'dist', 'deep', 'prod.pem'), 'SECRET-DIST-PEM\n');
  writeFileSync(join(checkout, 'node_modules', 'pkg', '.npmrc'), 'SECRET-NPMRC\n');
  writeFileSync(join(checkout, 'node_modules', 'pkg', 'index.js'), 'PKG-SOURCE\n');
  // a real repository whose remote URL carries a token
  const git = (...a: string[]) =>
    spawnSync('git', ['-C', checkout, ...a], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: 'a',
        GIT_AUTHOR_EMAIL: 'a@b.c',
        GIT_COMMITTER_NAME: 'a',
        GIT_COMMITTER_EMAIL: 'a@b.c',
      },
    });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'https://user:SECRET-TOKEN@example.test/r.git');
  git('add', 'src/app.ts');
  git('commit', '-q', '-m', 'first commit');
  writeFileSync(join(outside, 'secret.env'), 'SECRET-UAT\n');
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'SECRET-SSH\n');
  writeFileSync(join(home, '.bash_history'), 'SECRET-HISTORY\n');
  writeFileSync(join(home, '.aom-runner', 'config.json'), 'SECRET-RUNNER\n');
  symlinkSync(join(outside, 'secret.env'), join(checkout, 'link-to-secret'));
  return { home, checkout, outside, root: join(home, '.aom-runner') };
}

async function runScanBash(l: Layout & { root: string }, command: string) {
  const paths = runnerPaths(l.root);
  const A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
  const sb = await ensureSandbox(paths, A, 'Ada');
  mkdirSync(sb.scratch, { recursive: true });
  if (!devops) throw new Error('no devops role');
  const settings = buildShiftSettings(
    devops.permissions,
    policyCtx({
      runnerRoot: l.root,
      agentDir: paths.agentDir(A),
      cwd: sb.scratch,
      addDirs: [l.checkout],
      gitDirs: [],
      aomReadPaths: [paths.bin],
      realHome: l.home,
      sharedCacheDir: sb.cacheRoot,
      readOnlyScan: true,
    }),
    sb,
    'devops',
    true,
  );
  mkdirSync(sb.configDir, { recursive: true });
  writeFileSync(join(sb.configDir, 'settings.json'), JSON.stringify(settings, null, 2));
  writeFileSync(join(sb.configDir, 'mcp.json'), '{"mcpServers":{}}');
  const api = await fakeApi(command);
  // a DevOps shift runs with the real home as HOME (here the fake one), not the agent's private one
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    ...sandboxEnv(sb),
    CLAUDE_CONFIG_DIR: sb.configDir,
    HOME: l.home,
    CLAUDE_CODE_TMPDIR: sb.tmp,
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: 'sk-ant-fake-fake-fake',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    SSH_AUTH_SOCK: '',
  };
  const child = spawn(
    CLAUDE as string,
    [
      '-p',
      'scan',
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
      // (a scan passes no --add-dir: Claude Code would open the whole clone to the sandbox)
    ],
    { cwd: sb.scratch, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let tail = '';
  child.stdout.on('data', (d) => {
    tail = (tail + d).slice(-1500);
  });
  child.stderr.on('data', (d) => {
    tail = (tail + d).slice(-1500);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  await new Promise((r) => child.on('close', r));
  clearTimeout(timer);
  return { output: api.results.join('\n'), tail, settings };
}

/** `echo LABEL:$(head -c 60 path)`: prints the file's content, or the error, after the label. */
const peek = (label: string, path: string) => `echo "${label}:$(head -c 60 '${path}' 2>&1 | tr '\\n' ' ')"`;

describe.skipIf(!enabled)(
  'the scan sandbox against the real bubblewrap (skipped without bwrap + claude)',
  () => {
    it('reads normal source, runs bash, and cannot read any secret, anywhere', async () => {
      const l = layout();
      const c = l.checkout;
      const r = await runScanBash(
        l,
        [
          'echo BASH-RUNS',
          peek('SRC', `${c}/src/app.ts`),
          peek('PKG', `${c}/node_modules/pkg/index.js`),
          peek('HEAD', `${c}/.git/HEAD`),
          `echo "GITLOG:$(git -C ${c} log --oneline -1 2>&1 | head -c 80)"`,
          `echo "REMOTE:$(git -C ${c} remote -v 2>&1 | head -c 120)"`,
          peek('ENV', `${c}/.env`),
          peek('BUILDENV', `${c}/build/.env`),
          peek('DISTPEM', `${c}/dist/deep/prod.pem`),
          peek('NPMRC', `${c}/node_modules/pkg/.npmrc`),
          peek('GITCONF', `${c}/.git/config`),
          peek('LINK', `${c}/link-to-secret`),
          peek('UAT', `${l.outside}/secret.env`),
          peek('SSH', `${l.home}/.ssh/id_ed25519`),
          peek('HIST', `${l.home}/.bash_history`),
          peek('RUNNER', `${l.home}/.aom-runner/config.json`),
          'echo "NOWRITE:$({ echo x >> ' + c + '/src/app.ts; } 2>&1 | head -c 80)"',
        ].join('; '),
      );
      const out = r.output;
      expect(out, r.tail).toContain('BASH-RUNS');
      expect(out).toContain('SRC:NORMAL-SOURCE');
      expect(out).toContain('PKG:PKG-SOURCE');
      expect(out).toContain('HEAD:ref: refs/heads/main');
      expect(out).toContain('first commit');
      expect(out).not.toMatch(/SECRET-/);
      expect(out).toMatch(/NOWRITE:.*(Read-only|denied)/);
      expect(readFileSync(join(c, 'src', 'app.ts'), 'utf8')).toBe('NORMAL-SOURCE\n');
    }, 150_000);
  },
);
