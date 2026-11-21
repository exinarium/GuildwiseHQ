import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ENVIRONMENT_HELP_SECTION } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { addInstallRedirect, INSTALL_REDIRECT_MESSAGE } from '../src/adapters/claude-code.ts';
import type { ClaudeSettings } from '../src/adapters/claude-policy.ts';
import { containerRuntimeMasks } from '../src/adapters/claude-policy.ts';
import {
  CACHE_OWNER_FILE,
  CACHE_SWEEP_GRACE_MS,
  exactReopens,
  installCacheDir,
  installEnv,
  networkConfigKeys,
  parseDependencyChange,
  planDependencyChange,
  registryUrlProblem,
  runDependencyChange,
  scanWorkspace,
  stagedFiles,
  sweepInstallCaches,
} from '../src/devops/dependency-install.ts';
import { type ExecOptions, type Executor, realExecutor } from '../src/toolchain/exec.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * Owner 2026-11-21: "Devops is supposed to install dependencies". With the scrub on, a builder's Bash cannot write
 * package.json, the lockfiles or node_modules/.bin, so it asks with `aom devops install ...` and the DevOps side of the
 * runner (not scrubbed) runs the package manager in its worktree under the local policy (script-free unless allowed).
 */

describe('what an install request may be', () => {
  it('accepts the four package managers and registry names; refuses git, file and URL specs and flags', () => {
    expect(
      parseDependencyChange({
        tool: 'pnpm',
        action: 'add',
        packages: ['zod@^3.23', '@types/node'],
        dev: true,
      }),
    ).toEqual({
      ok: true,
      change: { tool: 'pnpm', action: 'add', packages: ['zod@^3.23', '@types/node'], dev: true },
    });
    expect(parseDependencyChange({ tool: 'npm', action: 'install', packages: [] })).toMatchObject({
      ok: true,
    });
    for (const bad of [
      'git+https://x/y.git',
      'file:../evil',
      'https://x/y.tgz',
      '--registry=http://x',
      '../local',
    ])
      expect(parseDependencyChange({ tool: 'npm', action: 'add', packages: [bad] }), bad).toMatchObject({
        ok: false,
      });
    expect(parseDependencyChange({ tool: 'pip', action: 'add', packages: ['x'] })).toMatchObject({
      ok: false,
    });
    expect(parseDependencyChange({ tool: 'npm', action: 'add', packages: [] })).toMatchObject({ ok: false });
    expect(parseDependencyChange({ tool: 'npm', action: 'install', packages: ['x'] })).toMatchObject({
      ok: false,
    });
  });

  it('runs script-free unless the repository may run install scripts on this workstation (R18-S)', () => {
    const dir = tmp();
    const add = { tool: 'npm' as const, action: 'add' as const, packages: ['left-pad'], dev: true };
    expect(planDependencyChange(add, dir, 'repo', false)).toMatchObject({
      ok: true,
      cmd: 'npm',
      args: ['install', '--save-dev', 'left-pad', '--ignore-scripts', '--git=git'],
    });
    expect(planDependencyChange(add, dir, 'repo', true)).toMatchObject({
      ok: true,
      args: ['install', '--save-dev', 'left-pad'],
    });
    expect(
      planDependencyChange({ tool: 'pnpm', action: 'remove', packages: ['x'] }, dir, 'repo', false),
    ).toMatchObject({
      args: [
        'remove',
        'x',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--config.manage-package-manager-versions=false',
      ],
    });
    // Yarn Berry plugins are repository code
    writeFileSync(join(dir, '.yarnrc.yml'), 'plugins:\n  - path: .yarn/plugins/x.cjs\n');
    const yarn = planDependencyChange(
      { tool: 'yarn', action: 'install', packages: [] },
      dir,
      'github.com/o/r',
      false,
    );
    expect(yarn).toMatchObject({
      ok: false,
      reason: expect.stringContaining('allow-scripts github.com/o/r'),
    });
  });
});

describe('a blocked install in Bash points the agent to DevOps', () => {
  const hookCommand = () => {
    const s = { permissions: { allow: [], deny: [] } } as unknown as ClaudeSettings;
    addInstallRedirect(s);
    const pre = s.hooks?.PreToolUse?.find((h) => h.matcher === 'Bash');
    return pre?.hooks[0]?.command as string;
  };
  const run = (cmd: string) =>
    spawnSync('bash', ['-c', hookCommand()], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }),
      encoding: 'utf8',
    });

  it.each([
    'npm install',
    'npm i',
    'pnpm add zod',
    'cd web && pnpm install',
    'yarn add -D x',
    'bun remove x',
    'npm ci',
  ])('refuses `%s` with the way to ask (exit 2, message on stderr)', (cmd) => {
    const r = run(cmd);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('aom devops install');
  });

  it.each(['npm run build', 'pnpm test', 'git status', 'echo npm-install', 'npx vitest run'])(
    'lets `%s` through',
    (cmd) => {
      expect(run(cmd).status).toBe(0);
    },
  );

  it('the card help says how to ask', () => {
    expect(ENVIRONMENT_HELP_SECTION).toContain('aom devops install');
    expect(INSTALL_REDIRECT_MESSAGE).toContain('aom devops install <tool> add <pkg>');
  });
});

describe('the DevOps install finds the user-space toolchains (deps-without-sudo)', () => {
  it('the runner executor puts the user-installed toolchains first on PATH, with the plan env', async () => {
    const plan = planDependencyChange({ tool: 'npm', action: 'install', packages: [] }, tmp(), 'repo', false);
    if (!plan.ok) throw new Error(plan.reason);
    const r = await realExecutor.run('sh', ['-c', 'echo "$PATH"; echo "$COREPACK_ENABLE_STRICT"'], {
      env: plan.env,
    });
    const [path, corepack] = r.stdout.trim().split('\n');
    expect(path?.split(':')).toContain(join(homedir(), '.local', 'share', 'guildwise', 'toolchains', 'bin'));
    expect(corepack).toBe('0');
  });
});

const bwrapOk =
  process.platform === 'linux' &&
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { encoding: 'utf8' }).status === 0;

const ws = (files: Record<string, string>, dir = tmp()) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
};
const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'x', dependencies: deps, ...extra });
const P = '{"name":"r"}';

describe('the workspace may name registry packages only', () => {
  it('a clean workspace (ranges, tags, npm: aliases, workspace: and catalog:) passes', () => {
    const dir = ws({
      'package.json': pkg({ zod: '^3.23.0', a: 'latest', b: 'npm:left-pad@1.3.0', c: 'workspace:*' }),
      'apps/web/package.json': pkg({ react: '18.3.1', d: 'catalog:' }),
      'package-lock.json':
        '{"packages":{"node_modules/zod":{"resolved":"https://registry.npmjs.org/zod/-/zod-3.23.8.tgz"}}}',
    });
    expect(scanWorkspace(dir)).toEqual([]);
  });

  it.each([
    ['git+ssh://git@github.com/org/private.git'],
    ['github:org/repo'],
    ['org/repo'],
    ['file:../../other-card'],
    ['link:/home/runner/secret'],
    ['https://evil.example/x.tgz?d=data'],
  ])('a WORKSPACE package.json with "%s" is refused, without echoing it', (spec) => {
    const p = scanWorkspace(ws({ 'package.json': pkg({}), 'apps/x/package.json': pkg({ x: spec }) })).join(
      '\n',
    );
    expect(p).toContain('apps/x/package.json dependencies: an entry is not a registry package');
    expect(p).not.toContain(spec);
  });

  it('overrides, resolutions, packageExtensions, pnpm-workspace.yaml and .yarnrc.yml are checked; node_modules is not', () => {
    const cases: Array<[Record<string, string>, string]> = [
      [
        { 'package.json': pkg({}, { overrides: { a: { b: 'git+https://x/y.git' } } }) },
        'overrides names something',
      ],
      [
        { 'package.json': pkg({}, { pnpm: { overrides: { c: 'file:/tmp/c' } } }) },
        'pnpm.overrides names something',
      ],
      [
        { 'package.json': pkg({}, { packageExtensions: { 'a@*': { dependencies: { z: 'file:../z' } } } }) },
        'packageExtensions',
      ],
      [
        { 'package.json': P, 'pnpm-workspace.yaml': "overrides:\n  x: 'git+ssh://git@github.com/o/r.git'\n" },
        'pnpm-workspace.yaml overrides',
      ],
      [
        { 'package.json': P, 'pnpm-workspace.yaml': 'catalogs:\n  evil:\n    y: file:/home/runner\n' },
        'pnpm-workspace.yaml catalogs',
      ],
      [
        { 'package.json': P, 'pnpm-workspace.yaml': 'patchedDependencies:\n  a@1.0.0: patches/a.patch\n' },
        'patched dependencies',
      ],
      [
        {
          'package.json': P,
          '.yarnrc.yml': "packageExtensions:\n  'a@*':\n    dependencies:\n      z: 'patch:z@1#./p.patch'\n",
        },
        '.yarnrc.yml packageExtensions',
      ],
    ];
    for (const [files, want] of cases) expect(scanWorkspace(ws(files)).join('\n'), want).toContain(want);
    expect(
      scanWorkspace(ws({ 'package.json': P, 'node_modules/e/package.json': pkg({ e: 'git+ssh://x' }) })),
    ).toEqual([]);
  });

  it('URLs are parsed as Node parses them (the backslash-userinfo trick, credentials, http, lookalikes); never echoed', () => {
    const hosts = new Set(['registry.npmjs.org']);
    expect(registryUrlProblem('https://registry.npmjs.org/zod/-/zod-3.23.8.tgz', hosts)).toBeNull();
    for (const bad of [
      'https://evil.com\\@registry.npmjs.org/x.tgz',
      'https://user:pw@registry.npmjs.org/x.tgz',
      'https://registry.npmjs.org@evil.com/x.tgz',
      'http://registry.npmjs.org/x.tgz',
      'https://registry.npmjs.org.evil.com/x.tgz',
      'https://[::1]/x.tgz',
    ])
      expect(registryUrlProblem(bad, hosts), bad).not.toBeNull();
    const lock = scanWorkspace(
      ws({
        'package.json': P,
        'package-lock.json': '{"resolved":"https://evil.com\\@registry.npmjs.org/x.tgz"}',
      }),
    ).join();
    expect(lock).toContain('a URL has a backslash');
    expect(lock).not.toContain('evil.com');
    const rc = scanWorkspace(
      ws({ 'package.json': P, '.npmrc': 'registry=https://user:ghp_SECRET@npm.evil.example/\n' }),
    ).join();
    expect(rc).toContain('a URL carries a user or password');
    expect(rc).not.toContain('ghp_SECRET');
    expect(
      scanWorkspace(ws({ 'package.json': P, 'yarn.lock': 'x@git+ssh://git@github.com/o/r.git:\n' })).join(),
    ).toContain('yarn.lock has a non-registry dependency');
  });

  it('a registry override is refused unless the owner allowed that host', () => {
    for (const [f, text] of [
      ['.npmrc', 'registry=https://npm.evil.example/\n'],
      ['apps/x/.npmrc', '@org:registry=https://npm.evil.example/\n'],
      ['.yarnrc.yml', 'npmRegistryServer: "https://npm.evil.example"\n'],
      ['bunfig.toml', '[install]\nregistry = "https://npm.evil.example/"\n'],
    ] as const) {
      const dir = ws({ 'package.json': pkg({}), 'apps/x/package.json': pkg({}), [f]: text });
      expect(scanWorkspace(dir).join(), f).toContain('not an allowed registry');
      expect(scanWorkspace(dir, ['npm.evil.example']), f).toEqual([]);
    }
  });

  it('proxy and TLS settings (proxy, https-proxy, strict-ssl=false, ca, cafile) are refused unless policy allows them', () => {
    for (const [f, text, key] of [
      ['.npmrc', 'proxy=evil.example:8080\n', 'proxy'],
      ['.npmrc', 'https-proxy=http://evil.example:3128\n', 'https-proxy'],
      ['.npmrc', 'strict-ssl=false\n', 'strict-ssl'],
      ['apps/x/.npmrc', 'cafile=/etc/evil.pem\n', 'cafile'],
      ['.yarnrc', 'strict-ssl false\n', 'strict-ssl'],
      ['.yarnrc.yml', 'httpsProxy: "http://evil.example:3128"\n', 'httpsproxy'],
      ['bunfig.toml', '[install]\nca = "-----BEGIN CERTIFICATE-----"\n', 'ca'],
    ] as const) {
      const dir = ws({ 'package.json': P, 'apps/x/package.json': P, [f]: text });
      const p = scanWorkspace(dir).join();
      expect(p, f).toContain(`sets ${key}`);
      expect(p, f).not.toContain('evil.example');
      expect(
        scanWorkspace(dir, ['evil.example'], true).filter((x) => x.includes('proxy or TLS')),
        f,
      ).toEqual([]);
    }
    expect(networkConfigKeys('.npmrc', 'save-exact=true\nregistry=https://registry.npmjs.org/\n')).toEqual(
      [],
    );
  });

  it('a binary bun.lockb refuses the install', () => {
    expect(scanWorkspace(ws({ 'package.json': P, 'bun.lockb': 'binary' })).join()).toContain(
      'binary Bun lockfile',
    );
  });
});

describe('the box re-opens exactly the package manager and Node, never a broad folder', () => {
  it('a pnpm standalone at ~/.local/share/pnpm/pnpm re-opens that file only, never ~/.local/share', () => {
    const home = tmp();
    mkdirSync(join(home, '.local', 'share', 'pnpm'), { recursive: true });
    writeFileSync(join(home, '.local', 'share', 'pnpm', 'pnpm'), '#!/bin/sh\n', { mode: 0o755 });
    const node = join(home, '.local', 'bin', 'node');
    mkdirSync(dirname(node), { recursive: true });
    writeFileSync(node, '', { mode: 0o755 });
    const r = exactReopens({
      toolPath: join(home, '.local', 'share', 'pnpm', 'pnpm'),
      nodeExec: node, // <home>/.local/bin/node: two levels up is ~/.local, which is broad
      realHome: home,
      masked: [join(home, '.ssh')],
    });
    expect(r).toEqual([realpathSync(join(home, '.local', 'share', 'pnpm', 'pnpm'))]);
    expect(r).not.toContain(join(home, '.local'));
    expect(r).not.toContain(join(home, '.local', 'share'));
  });

  it('a JavaScript package manager re-opens its package folder; an ancestor of a masked path is never re-opened', () => {
    const root = tmp();
    const pm = join(root, 'lib', 'node_modules', 'npm');
    mkdirSync(join(pm, 'bin'), { recursive: true });
    writeFileSync(join(pm, 'package.json'), '{}');
    writeFileSync(join(pm, 'bin', 'npm-cli.js'), '');
    const r = exactReopens({
      toolPath: join(pm, 'bin', 'npm-cli.js'),
      nodeExec: '/nonexistent',
      realHome: tmp(),
      masked: [],
    });
    expect(r).toEqual([realpathSync(pm)]);
    expect(
      exactReopens({
        toolPath: join(pm, 'bin', 'npm-cli.js'),
        nodeExec: '/nonexistent',
        realHome: tmp(),
        masked: [join(realpathSync(pm), 'secret')],
      }),
    ).toEqual([]);
  });
});

describe('container sockets are masked, also through symlinks', () => {
  it('lists container-looking /run entries and the targets of the symlinks among them', () => {
    const run = tmp();
    const svc = join(run, 'docker-svc');
    mkdirSync(svc);
    writeFileSync(join(svc, 'docker.sock'), '');
    symlinkSync(join(svc, 'docker.sock'), join(run, 'docker.sock'));
    mkdirSync(join(run, 'podman'));
    mkdirSync(join(run, 'unrelated'));
    const m = containerRuntimeMasks([run]);
    expect(m).toEqual(
      expect.arrayContaining([
        '/run/user',
        '/run/docker-svc',
        join(run, 'docker.sock'),
        realpathSync(join(svc, 'docker.sock')),
        join(run, 'podman'),
      ]),
    );
    expect(m).not.toContain(join(run, 'unrelated'));
  });
});

describe('the install environment', () => {
  it('holds no credential from the runner; its only proxy is the box egress bridge', () => {
    const env = installEnv({
      path: '/usr/bin',
      cacheRoot: '/c',
      extra: {},
      proxyPort: 18080,
      parent: {
        GH_TOKEN: 'x',
        GITHUB_TOKEN: 'x',
        SSH_AUTH_SOCK: '/s',
        NPM_TOKEN: 'x',
        AOM_SHIFT_TOKEN: 'x',
        AWS_ACCESS_KEY_ID: 'x',
        GIT_ASKPASS: '/a',
        HTTPS_PROXY: 'http://user:pw@corp-proxy:8080',
        LANG: 'C.UTF-8',
        HOME: '/home/runner',
      },
    });
    for (const k of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'SSH_AUTH_SOCK',
      'NPM_TOKEN',
      'AOM_SHIFT_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'GIT_ASKPASS',
    ])
      expect(env[k], k).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:18080');
    expect(Object.values(env).join(' ')).not.toContain('corp-proxy');
    expect(env.HOME).toBe('/tmp/home');
    expect(env.LANG).toBe('C.UTF-8');
  });
});

/** An executor that runs the staging boxes for real and hands the install itself to `install`. */
const stagingReal = (install: Executor['run']): Executor => ({
  run: (cmd, args, opts) =>
    args.includes('--unshare-all') ? realExecutor.run(cmd, args, opts) : install(cmd, args, opts),
});
const ok0 = { exitCode: 0, stdout: '', stderr: '' };

const base = (exec: Executor, dir: string) => ({
  dir,
  repo: 'github.com/o/r',
  change: { tool: 'npm' as const, action: 'install' as const, packages: [] },
  exec,
  scriptsAllowed: false,
  runnerRoot: tmp(),
  realHome: tmp(),
  cacheRoot: tmp(),
  tmpRoot: tmp(),
});

describe.skipIf(!bwrapOk)(
  'staging and copy-back run boxed: symlinks never reach outside the worktree',
  () => {
    it('a workspace git dependency is refused before the package manager runs', async () => {
      const dir = ws({
        'package.json': '{"name":"r","workspaces":["packages/*"]}',
        'packages/p/package.json':
          '{"name":"p","dependencies":{"x":"git+ssh://git@github.com/o/private.git"}}',
      });
      let ran = false;
      const r = await runDependencyChange(
        base(
          stagingReal(async () => {
            ran = true;
            return ok0;
          }),
          dir,
        ),
      );
      expect(r).toMatchObject({
        ok: false,
        error: expect.stringContaining('packages/p/package.json dependencies'),
      });
      expect(ran).toBe(false);
    });

    it('a staged file that is a symlink to a secret outside the worktree refuses the install; nothing of it is echoed', async () => {
      const secretDir = tmp();
      writeFileSync(join(secretDir, '.git-credentials'), 'https://user:ghp_SECRET@github.com\n');
      const dir = ws({ 'package.json': P, 'apps/x/package.json': P });
      symlinkSync(join(secretDir, '.git-credentials'), join(dir, 'apps', 'x', '.npmrc'));
      // a symlinked parent folder too
      symlinkSync(secretDir, join(dir, 'linked'));
      let ran = false;
      const r = await runDependencyChange(
        base(
          stagingReal(async () => {
            ran = true;
            return ok0;
          }),
          dir,
        ),
      );
      // stagedFiles skips symlinks, so the link is not even listed; if it were swapped in after the listing, the box refuses
      expect(JSON.stringify(r)).not.toContain('ghp_SECRET');
      expect(ran || !r.ok).toBe(true);
    });

    it('a manifest that is a symlink to a secret is never staged: the listing and the copy run in the box', async () => {
      const secretDir = tmp();
      writeFileSync(join(secretDir, 'secret.json'), '{"dependencies":{"x":"git+ssh://SECRET"}}');
      const dir = ws({ 'package.json': P, 'apps/x/package.json': P });
      rmSync(join(dir, 'apps', 'x', 'package.json'));
      symlinkSync(join(secretDir, 'secret.json'), join(dir, 'apps', 'x', 'package.json'));
      let staged = 'unset';
      const r = await runDependencyChange(
        base(
          stagingReal(async (_c, _a, opts) => {
            const f = join(opts?.cwd as string, 'apps', 'x', 'package.json');
            staged = existsSync(f) ? readFileSync(f, 'utf8') : 'absent';
            return ok0;
          }),
          dir,
        ),
      );
      expect(staged).toBe('absent');
      expect(JSON.stringify(r)).not.toContain('SECRET');
    });

    it('a folder that is a symlink out of the worktree is not descended into: nothing of it is staged', async () => {
      const outside = ws({ 'package.json': '{"dependencies":{"x":"git+ssh://SECRET"}}' });
      const dir = ws({ 'package.json': P, 'apps/x/package.json': P });
      rmSync(join(dir, 'apps', 'x'), { recursive: true });
      symlinkSync(outside, join(dir, 'apps', 'x'));
      let staged = '';
      const r = await runDependencyChange(
        base(
          stagingReal(async (_c, _a, opts) => {
            staged = existsSync(join(opts?.cwd as string, 'apps', 'x', 'package.json')) ? 'staged' : 'absent';
            return ok0;
          }),
          dir,
        ),
      );
      expect(staged).toBe('absent');
      expect(JSON.stringify(r)).not.toContain('SECRET');
    });

    it('a manifest swapped between the scan and the install does not reach the package manager (it runs on the scanned stage)', async () => {
      const dir = ws({
        'package.json': '{"name":"r","workspaces":["apps/*"]}',
        'apps/x/package.json': '{"name":"x","dependencies":{"zod":"^3"}}',
      });
      let seenByPm = '';
      let cwd = '';
      const r = await runDependencyChange(
        base(
          stagingReal(async (_c, _a, opts) => {
            writeFileSync(
              join(dir, 'apps', 'x', 'package.json'),
              '{"name":"x","dependencies":{"evil":"git+ssh://git@github.com/o/p.git"}}',
            );
            cwd = opts?.cwd as string;
            seenByPm = readFileSync(join(cwd, 'apps', 'x', 'package.json'), 'utf8');
            return ok0;
          }),
          dir,
        ),
      );
      expect(r).toMatchObject({ ok: true });
      expect(cwd).not.toBe(dir);
      expect(seenByPm).toContain('zod');
      expect(seenByPm).not.toContain('evil');
    });

    it('a package folder swapped to a symlink before copy-back: nothing is written or deleted outside the worktree', async () => {
      const outside = tmp();
      mkdirSync(join(outside, 'node_modules', 'keep'), { recursive: true });
      writeFileSync(join(outside, 'node_modules', 'keep', 'index.js'), 'KEEP');
      writeFileSync(join(outside, 'package.json'), '{"name":"outside"}');
      const dir = ws({
        'package.json': '{"name":"r","workspaces":["apps/*"]}',
        'apps/x/package.json': '{"name":"x"}',
      });
      const r = await runDependencyChange(
        base(
          stagingReal(async (_c, _a, opts) => {
            const stage = opts?.cwd as string;
            // the install changes the workspace manifest and writes its node_modules
            writeFileSync(join(stage, 'apps', 'x', 'package.json'), '{"name":"x","version":"2.0.0"}');
            mkdirSync(join(stage, 'apps', 'x', 'node_modules', 'zod'), { recursive: true });
            // meanwhile the shift turns apps/x into a symlink to another folder
            rmSync(join(dir, 'apps', 'x'), { recursive: true });
            symlinkSync(outside, join(dir, 'apps', 'x'));
            return ok0;
          }),
          dir,
        ),
      );
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('could not be put back') });
      expect(readFileSync(join(outside, 'package.json'), 'utf8')).toBe('{"name":"outside"}');
      expect(readFileSync(join(outside, 'node_modules', 'keep', 'index.js'), 'utf8')).toBe('KEEP');
      expect(existsSync(join(outside, 'node_modules', 'zod'))).toBe(false);
    });

    it('one install per worktree at a time; each worktree has its own package cache', async () => {
      let release: () => void = () => {};
      const caches: string[] = [];
      const exec = stagingReal(async (_c, _a, opts) => {
        caches.push(String(opts?.env?.npm_config_cache));
        await new Promise<void>((r) => {
          release = r;
        });
        return ok0;
      });
      const cacheRoot = tmp();
      const a = { ...base(exec, ws({ 'package.json': P })), cacheRoot };
      const first = runDependencyChange(a);
      await new Promise((r) => setTimeout(r, 1500));
      expect(await runDependencyChange(a)).toMatchObject({
        ok: false,
        error: expect.stringContaining('another install is running'),
      });
      release();
      expect(await first).toMatchObject({ ok: true });
      const b = {
        ...base(
          stagingReal(async (_c, _a2, opts) => {
            caches.push(String(opts?.env?.npm_config_cache));
            return ok0;
          }),
          ws({ 'package.json': P }),
        ),
        cacheRoot,
      };
      expect(await runDependencyChange(b)).toMatchObject({ ok: true });
      expect(caches).toHaveLength(2);
      expect(caches[0]).not.toBe(caches[1]);
      for (const c of caches) expect(c.startsWith(cacheRoot)).toBe(true);
    }, 30_000);
  },
);

describe.skipIf(!bwrapOk)('copy-back is transactional, and caches and registries follow the policy', () => {
  it('a later target that points out of the worktree stops copy-back before anything is written', async () => {
    const outside = tmp();
    const dir = ws({
      'package.json': '{"name":"r","workspaces":["apps/*"]}',
      'apps/a/package.json': '{"name":"a"}',
      'apps/b/package.json': '{"name":"b"}',
      'apps/a/node_modules/old/index.js': 'OLD-A',
    });
    const r = await runDependencyChange(
      base(
        stagingReal(async (_c, _a, opts) => {
          const stage = opts?.cwd as string;
          writeFileSync(join(stage, 'apps', 'a', 'package.json'), '{"name":"a","version":"2.0.0"}');
          mkdirSync(join(stage, 'apps', 'a', 'node_modules', 'new'), { recursive: true });
          mkdirSync(join(stage, 'apps', 'b', 'node_modules', 'new'), { recursive: true });
          // apps/b turns into a symlink out of the worktree
          rmSync(join(dir, 'apps', 'b'), { recursive: true });
          symlinkSync(outside, join(dir, 'apps', 'b'));
          return ok0;
        }),
        dir,
      ),
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('could not be put back') });
    // nothing was written: apps/a keeps its manifest and its old node_modules
    expect(readFileSync(join(dir, 'apps', 'a', 'package.json'), 'utf8')).toBe('{"name":"a"}');
    expect(readFileSync(join(dir, 'apps', 'a', 'node_modules', 'old', 'index.js'), 'utf8')).toBe('OLD-A');
    expect(existsSync(join(dir, 'apps', 'a', 'node_modules', 'new'))).toBe(false);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('a successful copy-back swaps node_modules whole and leaves no temporary folder', async () => {
    const dir = ws({ 'package.json': P, 'node_modules/old/index.js': 'OLD' });
    const r = await runDependencyChange(
      base(
        stagingReal(async (_c, _a, opts) => {
          mkdirSync(join(opts?.cwd as string, 'node_modules', 'zod'), { recursive: true });
          return ok0;
        }),
        dir,
      ),
    );
    expect(r).toMatchObject({ ok: true });
    expect(existsSync(join(dir, 'node_modules', 'zod'))).toBe(true);
    expect(existsSync(join(dir, 'node_modules', 'old'))).toBe(false);
    expect(readdirSync(dir).filter((n) => n.startsWith('node_modules.aom-'))).toEqual([]);
  });

  it('a private registry is reachable only when policy lists it (passed to the proxy as an explicit endpoint)', async () => {
    const seen: Array<{ allowedHosts: string[]; privateEndpoints?: string[] }> = [];
    const run = (allowedRegistries?: string[]) =>
      runDependencyChange({
        ...base(
          stagingReal(async () => ok0),
          ws({ 'package.json': P }),
        ),
        ...(allowedRegistries ? { allowedRegistries } : {}),
        startProxy: async (opts) => {
          seen.push({
            allowedHosts: opts.allowedHosts,
            ...(opts.privateEndpoints ? { privateEndpoints: opts.privateEndpoints } : {}),
          });
          return { close: async () => {}, denied: () => [], asked: () => [] };
        },
      });
    await run();
    await run(['npm.lan.example']);
    expect(seen[0]).toEqual({
      allowedHosts: ['registry.npmjs.org', 'registry.yarnpkg.com'],
      privateEndpoints: [],
    });
    expect(seen[1]).toEqual({
      allowedHosts: ['registry.npmjs.org', 'registry.yarnpkg.com', 'npm.lan.example'],
      privateEndpoints: ['npm.lan.example:443'],
    });
  });

  it('the caches of worktrees that are gone are swept', async () => {
    const root = tmp();
    const live = tmp();
    const gone = join(tmp(), 'removed-worktree');
    for (const w of [live, gone]) {
      const d = installCacheDir(root, w);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, CACHE_OWNER_FILE), `${w}\n`);
    }
    mkdirSync(join(root, '0123456789abcdef')); // no owner file, older than the grace period (see `now` below)
    expect(await sweepInstallCaches(root, undefined, Date.now() + CACHE_SWEEP_GRACE_MS + 1000)).toBe(2);
    expect(readdirSync(root)).toEqual([installCacheDir(root, live).split('/').pop()]);
  });

  it('a brand-new cache whose owner file is not written yet survives a sweep started by another install', async () => {
    const root = tmp();
    const fresh = installCacheDir(root, tmp());
    mkdirSync(fresh, { recursive: true }); // just created, owner file not there yet
    expect(await sweepInstallCaches(root)).toBe(0);
    expect(existsSync(fresh)).toBe(true);
    // two installs of different worktrees at once: neither sweeps the other's new cache
    const exec = stagingReal(async () => ok0);
    const [a, b] = await Promise.all([
      runDependencyChange({ ...base(exec, ws({ 'package.json': P })), cacheRoot: root }),
      runDependencyChange({ ...base(exec, ws({ 'package.json': P })), cacheRoot: root }),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true });
    expect(readdirSync(root).filter((n) => existsSync(join(root, n, CACHE_OWNER_FILE)))).toHaveLength(2);
    expect(existsSync(fresh)).toBe(true);
  });

  it('the host-side listing is bounded in folders as well as files', () => {
    const dir = tmp();
    for (let i = 0; i < 50; i++) mkdirSync(join(dir, `d${i}`, 'x'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), P);
    const t = Date.now();
    expect(stagedFiles(dir, 2000, 10)).toContain('package.json');
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe.skipIf(!bwrapOk)('the real install box (bubblewrap, own network namespace)', () => {
  let abstract: Server | undefined;
  afterEach(() => abstract?.close());

  it('minimal env; writes only the stage and its own cache; no home, runner data, abstract socket or non-registry host', async () => {
    const runnerRoot = tmp();
    const dir = join(runnerRoot, 'worktrees', 'P', 'X');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"r"}');
    writeFileSync(join(runnerRoot, 'token'), 'RUNNER-SECRET');
    // a home outside /tmp (the box has its own /tmp), like a real one
    const realHome = mkdtempSync(join(userInfo().homedir, '.aom-install-home-'));
    writeFileSync(join(realHome, 'notes.txt'), 'HOME-SECRET');
    const outside = tmp();
    const cacheRoot = join(runnerRoot, 'cache');
    // a host-side abstract Unix socket (no path, not maskable): unreachable from another network namespace
    const name = `aom-test-${process.pid}-${Date.now()}`;
    abstract = createServer((s) => s.end('ABSTRACT-REACHED')).listen(`\0${name}`);
    // a fake "npm" in ~/.local/bin (re-opened as that single file); it reports into its npm cache (writable)
    const bin = join(realHome, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'npm'),
      [
        '#!/bin/sh',
        'R="$npm_config_cache"',
        'env > "$R/env.txt"',
        'echo w > "$PWD/written.txt" && echo STAGE-OK > "$R/stage.txt"',
        `(echo x > ${outside}/escaped.txt) 2>/dev/null || echo OUTSIDE-REFUSED > "$R/outside.txt"`,
        `(cat ${runnerRoot}/token 2>/dev/null || echo TOKEN-HIDDEN) > "$R/token.txt"`,
        `(cat ${realHome}/notes.txt 2>/dev/null || echo HOME-HIDDEN) > "$R/home.txt"`,
        `(ls ${dir} >/dev/null 2>&1 && echo WORKTREE-VISIBLE || echo WORKTREE-HIDDEN) > "$R/worktree.txt"`,
        `echo "RUNUSER=[$(ls -A /run/user 2>/dev/null | tr '\\n' ' ')]" > "$R/runuser.txt"`,
        `(socat -u ABSTRACT-CONNECT:${name} - 2>/dev/null || echo ABSTRACT-UNREACHABLE) > "$R/abstract.txt"`,
        `(curl -s -m 5 -o /dev/null https://example.com && echo FETCH-OK || echo NON-REGISTRY-REFUSED) > "$R/fetch.txt"`,
        `(curl -s -m 5 --noproxy '*' -o /dev/null https://1.1.1.1 && echo DIRECT-OK || echo NO-DIRECT-NETWORK) > "$R/direct.txt"`,
        `echo '{"name":"r","version":"2.0.0"}' > package.json`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const denied: string[] = [];
    process.env.GH_TOKEN = 'ghp_should_not_pass';
    let r: Awaited<ReturnType<typeof runDependencyChange>>;
    try {
      r = await runDependencyChange({
        dir,
        repo: 'github.com/o/r',
        change: { tool: 'npm', action: 'install', packages: [] },
        exec: realExecutor,
        scriptsAllowed: false,
        runnerRoot,
        realHome,
        cacheRoot,
        tmpRoot: join(runnerRoot, 'install-stage'),
        parentEnv: { ...process.env, PATH: process.env.PATH ?? '' },
        startProxy: async (opts) => {
          const { startEgressProxy } = await import('../src/sandbox/egress-proxy.ts');
          return startEgressProxy({ ...opts, onDeny: (h) => denied.push(h) });
        },
      });
    } finally {
      delete process.env.GH_TOKEN;
      rmSync(realHome, { recursive: true, force: true });
    }
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    const cacheDir = join(
      cacheRoot,
      readdirSync(cacheRoot).find((n) => /^[0-9a-f]{16}$/.test(n)) as string,
      'npm',
    );
    const out = (f: string) => readFileSync(join(cacheDir, f), 'utf8');
    const env = out('env.txt');
    expect(env).not.toContain('GH_TOKEN');
    expect(env).not.toMatch(/^AOM_/m);
    expect(env).toContain('HOME=/tmp/home');
    expect(out('stage.txt')).toContain('STAGE-OK');
    expect(out('outside.txt')).toContain('OUTSIDE-REFUSED');
    expect(out('token.txt')).toContain('TOKEN-HIDDEN');
    expect(out('home.txt')).toContain('HOME-HIDDEN');
    expect(out('worktree.txt')).toContain('WORKTREE-HIDDEN');
    expect(out('runuser.txt').trim()).toBe('RUNUSER=[]');
    expect(out('abstract.txt')).toContain('ABSTRACT-UNREACHABLE');
    expect(out('fetch.txt')).toContain('NON-REGISTRY-REFUSED');
    expect(denied).toContain('example.com');
    expect(out('direct.txt')).toContain('NO-DIRECT-NETWORK');
    // the install's package.json came back; a stray file it wrote did not
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toContain('2.0.0');
    expect(existsSync(join(dir, 'written.txt'))).toBe(false);
  }, 60_000);
});

describe.skipIf(!bwrapOk)(
  'end to end: a builder gets a dependency installed by DevOps in its worktree',
  () => {
    let h: Harness | undefined;
    afterEach(async () => {
      await h?.stop();
      h = undefined;
    });

    it('npm runs boxed (own netns, staged, home hidden) with no credential; package.json comes back and is committed', async () => {
      const calls: Array<{ cmd: string; args: string[]; opts?: ExecOptions }> = [];
      const secrets = {
        GH_TOKEN: 'ghp_secret',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        AWS_SECRET_ACCESS_KEY: 'aws',
      };
      Object.assign(process.env, secrets);
      const executor: Executor = {
        run: async (cmd, args, opts) => {
          if (cmd !== 'bwrap' || args.includes('--unshare-all') || !args.includes('--unshare-net'))
            return realExecutor.run(cmd, args, opts);
          calls.push({ cmd, args, ...(opts ? { opts } : {}) });
          // what npm does in the stage: the dependency lands in package.json and a lockfile appears
          const stage = opts?.cwd as string;
          writeFileSync(
            join(stage, 'package.json'),
            `${JSON.stringify({ name: 'toy', devDependencies: { 'left-pad': '1.3.0' } }, null, 2)}\n`,
          );
          writeFileSync(join(stage, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}\n');
          return { exitCode: 0, stdout: 'added 1 package', stderr: '' };
        },
      };
      try {
        h = await startHarness({}, { executor });
        const { ended } = await h.runShift({
          stage: 'build',
          ref: 'TOY-1',
          mock: { build: ['deps_install'] },
        });
        expect(ended.outcome).toBe('reported');
      } finally {
        for (const k of Object.keys(secrets)) delete process.env[k];
      }
      const wt = worktreeOf(h);
      expect(calls).toHaveLength(1);
      const c = calls[0]!;
      const argv = c.args.slice(c.args.indexOf('--') + 1);
      expect(argv.slice(0, 2)).toEqual(['sh', '-c']);
      expect(argv.slice(-5)).toEqual([
        'install',
        '--save-dev',
        'left-pad@1.3.0',
        '--ignore-scripts',
        '--git=git',
      ]);
      const box = c.args.slice(0, c.args.indexOf('--')).join(' ');
      const stage = c.opts?.cwd as string;
      expect(stage.startsWith(join(h.dataDir, 'install-stage'))).toBe(true);
      expect(box).toContain('--unshare-net');
      expect(box).toContain(`--bind ${stage} ${stage}`);
      expect(box).not.toContain(`--bind ${wt} ${wt}`);
      expect(box).toContain(`--tmpfs ${h.dataDir}`);
      expect(box).toContain(`--tmpfs ${realpathSync(homedir())}`);
      expect(box).toMatch(new RegExp(`--bind ${resolve(h.dataDir, 'install-cache')}/[0-9a-f]{16} `));
      expect(box).not.toContain(`--bind ${resolve(h.dataDir, 'cache')} `);
      const env = c.opts?.env as Record<string, string>;
      expect(c.opts).toMatchObject({ exactEnv: true });
      expect(env).toMatchObject({
        HOME: '/tmp/home',
        COREPACK_ENABLE_STRICT: '0',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HTTPS_PROXY: 'http://127.0.0.1:18080',
      });
      for (const k of Object.keys(secrets)) expect(env[k], k).toBeUndefined();
      expect(Object.keys(env).filter((k) => k.startsWith('AOM_') || /TOKEN|SECRET|KEY/.test(k))).toEqual([]);
      const answer = readFileSync(join(wt, '.guildwise-mock', 'deps-install.txt'), 'utf8');
      expect(answer.split('\n')[0]).toBe('0');
      expect(answer).toContain(
        'DevOps ran `npm install --save-dev left-pad@1.3.0 --ignore-scripts --git=git` for your worktree: done',
      );
      const show = spawnSync('git', ['-C', wt, 'show', '--stat', 'HEAD'], { encoding: 'utf8' }).stdout;
      expect(show).toContain('package.json');
      expect(show).toContain('package-lock.json');
      expect(h.server.of('rpc.request').some((r) => r.method === 'devops.install')).toBe(false);
    }, 90_000);
  },
);
