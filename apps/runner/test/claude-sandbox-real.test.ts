import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';

import { userInfo } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { addInstallRedirect } from '../src/adapters/claude-code.ts';
import { buildMentionWorkSettings, buildShiftSettings, gitDirsOf } from '../src/adapters/claude-policy.ts';
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
  opts: {
    cwdKind?: 'worktree' | 'scratch';
    scrub?: boolean;
    linkedNode?: boolean;
    env?: Record<string, string>;
    before?: (root: string) => void;
    /** gate-fixes-1: a working @mention's settings (builder permissions, `buildMentionWorkSettings`) instead of a role's. */
    mention?: boolean;
  } = {},
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
  opts.before?.(root);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'a',
    GIT_AUTHOR_EMAIL: 'a@b.c',
    GIT_COMMITTER_NAME: 'a',
    GIT_COMMITTER_EMAIL: 'a@b.c',
  };
  if (opts.linkedNode) {
    // a card worktree (linked: `.git` is a file) of a Node project with package.json, a lockfile and scripts/ committed
    rmSync(cwd, { recursive: true, force: true });
    const repo = join(root, 'repos', 'P-1');
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main', repo]);
    writeFileSync(join(repo, 'package.json'), '{"name":"probe","version":"1.0.0","private":true}\n');
    writeFileSync(
      join(repo, 'package-lock.json'),
      '{"name":"probe","lockfileVersion":3,"requires":true,"packages":{}}\n',
    );
    writeFileSync(join(repo, 'scripts', 'build.sh'), 'echo build\n');
    spawnSync('git', ['-C', repo, 'add', '-A']);
    spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { env: gitEnv });
    spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'X-1', cwd]);
  } else if (opts.cwdKind !== 'scratch') {
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
  const build = opts.mention
    ? (
        pp: typeof p,
        c: Parameters<typeof buildShiftSettings>[1],
        s: Parameters<typeof buildShiftSettings>[2],
      ) => buildMentionWorkSettings(pp, c, s)
    : (
        pp: typeof p,
        c: Parameters<typeof buildShiftSettings>[1],
        s: Parameters<typeof buildShiftSettings>[2],
      ) => buildShiftSettings(pp, c, s, roleKey);
  const settings = build(
    p,
    policyCtx({
      runnerRoot: root,
      agentDir: paths.agentDir(A),
      cwd,
      gitDirs: opts.linkedNode ? gitDirsOf(cwd) : [],
      aomReadPaths: [paths.bin],
      realHome: userInfo().homedir,
      sharedCacheDir: sb.cacheRoot,
    }),
    sb,
  );
  // what the adapter adds to a scrubbed, non-DevOps session: an install in Bash is refused with the way to ask DevOps
  if (opts.scrub) addInstallRedirect(settings);
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
    // what sessionEnv adds with `scrubSubprocessEnv` (on by default since 1.10.0)
    ...(opts.scrub ? { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } : {}),
    ...(opts.env ?? {}),
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

    it('builder with the scrub on (the 1.10.0 default) in a Node project: Bash cannot write the build files (owner question)', async () => {
      // Claude Code 2.1.330's scrub denies Bash writes to <cwd>/package.json, the lockfiles, node_modules/.bin, scripts,
      // .github, .claude and .env*, so a dependency install fails; other files stay writable. This pins today's behaviour
      // (BUILD.md, Questions): if Claude Code changes it, this test says so.
      const r = await runBashAs(
        'builder',
        [
          'echo "{}" > package.json && echo PKG-WRITE-OK',
          'mkdir -p node_modules/.bin && touch node_modules/.bin/x && echo BIN-WRITE-OK',
          'echo more >> scripts/build.sh && echo SCRIPTS-WRITE-OK',
          // `env npm`: past the install hint hook (a hint only; the scrub is what blocks the write)
          'env npm install --offline --no-audit --no-fund >/dev/null 2>&1 && echo NPM-INSTALL-OK',
          'echo SRC > src.txt && echo SRC-WRITE-OK',
          'true',
        ].join('; '),
        { scrub: true, linkedNode: true },
      );
      expect(r.output, r.stderr).toContain('SRC-WRITE-OK');
      expect(r.output, r.stderr).toMatch(/package\.json: Read-only file system/);
      for (const blocked of ['PKG-WRITE-OK', 'BIN-WRITE-OK', 'SCRIPTS-WRITE-OK', 'NPM-INSTALL-OK'])
        expect(r.output, blocked).not.toContain(blocked);
    }, 120_000);

    it('builder with the scrub on: `npm install` in Bash is refused with the way to ask DevOps (aom devops install)', async () => {
      const r = await runBashAs('builder', 'npm install', { scrub: true, linkedNode: true });
      expect(r.output, r.stderr).toContain('aom devops install');
      expect(r.output, r.stderr).not.toContain('Read-only file system');
    }, 120_000);

    it('tester (a browser role, Unix sockets open): no other user runtime dir and no container socket is reachable', async () => {
      const r = await runBashAs(
        'tester',
        'echo "RUNUSER=[$(ls -A /run/user 2>/dev/null | tr \'\\n\' \' \')]"; for p in /run/docker.sock /var/run/docker.sock /run/docker-svc/docker.sock /run/containerd/containerd.sock; do [ -S "$p" ] && echo "SOCKET $p"; done; echo PROBE-DONE',
      );
      expect(r.output, r.stderr).toContain('PROBE-DONE');
      expect(r.output, r.stderr).toContain('RUNUSER=[]');
      expect(r.output, r.stderr).not.toContain('SOCKET ');
    }, 120_000);

    it('a shift shell (builder) cannot read or write the install caches of any worktree (<data dir>/install-cache)', async () => {
      const r = await runBashAs(
        'builder',
        'cat ../../../install-cache/0123456789abcdef/npm/packument.json 2>&1 | head -1; echo x > ../../../install-cache/0123456789abcdef/npm/evil.json 2>&1 | head -1; ls ../../../install-cache 2>&1 | head -1; echo PROBE-DONE',
        {
          before: (root) => {
            mkdirSync(join(root, 'install-cache', '0123456789abcdef', 'npm'), { recursive: true });
            writeFileSync(
              join(root, 'install-cache', '0123456789abcdef', 'npm', 'packument.json'),
              'OTHER-WORKTREE-CACHE',
            );
          },
        },
      );
      expect(r.output, r.stderr).toContain('PROBE-DONE');
      expect(r.output, r.stderr).not.toContain('OTHER-WORKTREE-CACHE');
      expect(r.output, r.stderr).not.toContain('0123456789abcdef\n');
      expect(
        existsSync(join(r.cwd, '..', '..', '..', 'install-cache', '0123456789abcdef', 'npm', 'evil.json')),
      ).toBe(false);
    }, 120_000);

    it('the scrub keeps DOCKER_HOST, drops XDG_RUNTIME_DIR and strips a token (why DevOps is never scrubbed)', async () => {
      // Claude Code 2.1.330. DevOps, the only role that gets these two (DEVOPS_INHERITED_ENV), runs unscrubbed, so its
      // rootless Docker keeps working; a sandboxed role is not given either (INHERITED_ENV). This pins what the scrub does.
      const r = await runBashAs(
        'builder',
        'echo "DH=${DOCKER_HOST:-unset}"; echo "XDG=${XDG_RUNTIME_DIR:-unset}"; echo "TOK=${AOM_SHIFT_TOKEN:-unset}"',
        {
          scrub: true,
          linkedNode: true,
          env: {
            DOCKER_HOST: 'unix:///run/user/1234/docker.sock',
            XDG_RUNTIME_DIR: '/run/user/1234',
            AOM_SHIFT_TOKEN: 'aom-test-token-0123456789abcdef',
          },
        },
      );
      expect(r.output, r.stderr).toContain('DH=unix:///run/user/1234/docker.sock');
      expect(r.output, r.stderr).toContain('XDG=unset');
      expect(r.output, r.stderr).toContain('TOK=unset');
    }, 120_000);

    it('reviewer with the scrub on (the 1.10.0 default): the scrub’s extra mount points exist, no bwrap error, cleaned up', async () => {
      // a standalone repository (`.git` is a directory), like a PR review checkout: Claude Code also mounts over
      // .git/config.lock there; and `scripts`, `.github`, `package.json`, the `.env` files, ... at the root
      const r = await runBashAs('reviewer', 'echo PROBE-OK; git log --oneline | head -1', { scrub: true });
      expect(r.output, r.stderr).not.toContain("Can't create file");
      expect(r.output, r.stderr).toContain('PROBE-OK');
      expect(r.output, r.stderr).toContain('init');
      for (const n of ['scripts', 'package.json', '.env', join('.git', 'config.lock')])
        expect(existsSync(join(r.cwd, n)), n).toBe(false);
    }, 120_000);
  },
);

describe.skipIf(!enabled)(
  'gate-fixes-1: a working @mention in the real Claude Code sandbox (skipped without claude + bwrap)',
  () => {
    const heads = (cwd: string) => {
      const admin = spawnSync('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], {
        encoding: 'utf8',
      }).stdout.trim();
      const read = (f: string) => spawnSync('cat', [f], { encoding: 'utf8' }).stdout;
      return `${read(join(admin, 'HEAD'))}|${read(join(admin, '..', '..', 'HEAD'))}`;
    };
    const mention = (command: string) => runBashAs('builder', command, { linkedNode: true, mention: true });

    it('F4: the mention commits in the card worktree (no "Read-only file system")', async () => {
      const r = await mention(
        'echo "- mention-edit" >> package.json && git add package.json && git -c user.email=a@b.c -c user.name=a commit -qm mention-edit && git log --oneline -1',
      );
      expect(r.output, r.stderr).not.toContain('Read-only file system');
      expect(r.output, r.stderr).toContain('mention-edit');
      expect(
        spawnSync('git', ['-C', r.cwd, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).stdout.trim(),
      ).toBe('mention-edit');
    }, 120_000);

    it('F1b: the table forms are denied, and a wrapper is stopped by the read-only HEAD files', async () => {
      for (const c of ['git -C . switch -c gate-m1', 'GIT_DIR=.git git checkout -b gate-m2']) {
        const r = await mention(c);
        expect(r.output, `${c}: ${r.stderr}`).toMatch(/denied/i);
      }
      // a wrapper no rule can name: the OS fence (read-only HEAD files) stops it, and nothing moved
      const w = await mention('sh -c "git switch -c gate-m3"; echo EXIT=$?');
      const before = heads(w.cwd);
      expect(w.output, w.stderr).toMatch(/unable to update HEAD|denied/i);
      expect(before).toContain('ref: refs/heads/X-1');
      const repo = join(w.cwd, '..', '..', '..', 'repos', 'P-1');
      const m = await mention(`sh -c "git -C ${repo} symbolic-ref HEAD refs/heads/gate-m4"; echo EXIT=$?`);
      expect(m.output, m.stderr).not.toContain('EXIT=0');
      expect(heads(m.cwd)).toContain('ref: refs/heads/main');
      expect(heads(m.cwd)).not.toContain('gate-m');
    }, 300_000);
  },
);
