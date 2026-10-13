import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { sessionEnv } from '../src/adapters/claude-code.ts';
import { buildShiftSettings, denyAround, REGISTRY_DOMAINS } from '../src/adapters/claude-policy.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { runnerPaths } from '../src/paths.ts';
import {
  CACHE_KINDS,
  DOTNET_SHM_DIR,
  ensureSandbox,
  sandboxEnv,
  sharedCacheDir,
  sharedCacheRoot,
} from '../src/sandbox/sandbox.ts';
import { cleanupTmp, tmp } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

cleanupTmp();
const A1 = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const A2 = '019e3f6a-7b1c-7a2d-8c3e-0123456789a2';

const role = (key: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === key);
  if (!r) throw new Error(key);
  return r;
};

describe('shared package caches (one set per runner)', () => {
  it('creates <runner root>/cache/<kind> once, shared by every agent', async () => {
    const paths = runnerPaths(tmp());
    const a = await ensureSandbox(paths, A1, 'Ada');
    const b = await ensureSandbox(paths, A2, 'Bo');
    expect(a.cacheRoot).toBe(join(paths.root, 'cache'));
    expect(b.cacheRoot).toBe(a.cacheRoot);
    for (const k of CACHE_KINDS)
      expect(statSync(sharedCacheDir(sharedCacheRoot(paths), k)).isDirectory()).toBe(true);
    const ea = sandboxEnv(a);
    const eb = sandboxEnv(b);
    // different homes, same caches
    expect(ea.HOME).not.toBe(eb.HOME);
    expect(ea.NUGET_PACKAGES).toBe(eb.NUGET_PACKAGES);
  });

  it('points every package manager at the shared cache dirs', async () => {
    const paths = runnerPaths(tmp());
    const sb = await ensureSandbox(paths, A1, 'Ada');
    const c = (k: (typeof CACHE_KINDS)[number]) => join(paths.root, 'cache', k);
    expect(sandboxEnv(sb)).toMatchObject({
      NUGET_PACKAGES: c('nuget'),
      NUGET_HTTP_CACHE_PATH: c('nuget-http'),
      NUGET_PLUGINS_CACHE_PATH: c('nuget-plugins'),
      npm_config_cache: c('npm'),
      npm_config_store_dir: c('pnpm'),
      YARN_CACHE_FOLDER: c('yarn'),
      PIP_CACHE_DIR: c('pip'),
      GRADLE_USER_HOME: c('gradle'),
      MAVEN_OPTS: `-Dmaven.repo.local=${c('maven')}`,
      GOMODCACHE: c('go-mod'),
      GOCACHE: c('go-build'),
    });
    // cargo's home also holds credentials and installed binaries: not shared
    expect(sandboxEnv(sb).CARGO_HOME).toBeUndefined();
  });

  it('sets the .NET variables: a private writable CLI home, no first-run noise, no build servers', async () => {
    const paths = runnerPaths(tmp());
    const sb = await ensureSandbox(paths, A1, 'Ada');
    expect(sandboxEnv(sb)).toMatchObject({
      DOTNET_CLI_HOME: sb.home,
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      DOTNET_NOLOGO: '1',
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      MSBUILDDISABLENODEREUSE: '1',
      DOTNET_CLI_USE_MSBUILD_SERVER: '0',
      UseSharedCompilation: 'false',
      // no MSBuild worker nodes: their /tmp/MSBuild<pid> pipes cannot be created in the sandbox (card P4-7)
      DOTNET_PROCESSOR_COUNT: '1',
      // no SourceLink probe of <repo>/.gitmodules (#33)
      EnableSourceControlManagerQueries: 'false',
    });
  });

  it("offers the user's ~/.nuget/packages as a read-only NuGet fallback only when it exists", async () => {
    const paths = runnerPaths(tmp());
    const sb = await ensureSandbox(paths, A1, 'Ada');
    const home = tmp();
    expect(sandboxEnv(sb, home).NUGET_FALLBACK_PACKAGES).toBeUndefined();
    mkdirSync(join(home, '.nuget', 'packages'), { recursive: true });
    expect(sandboxEnv(sb, home).NUGET_FALLBACK_PACKAGES).toBe(join(home, '.nuget', 'packages'));
  });

  it('a sandboxed session gets the cache env; the unsandboxed DevOps engineer keeps the user caches', async () => {
    const paths = runnerPaths(tmp());
    const sb = await ensureSandbox(paths, A1, 'Ada');
    const cfg = ClaudeRuntimeConfigSchema.parse({});
    const base = { env: sandboxEnv(sb), sandbox: sb as never };
    expect(sessionEnv({ ...base, agent: { isDevops: false } }, cfg, {}).NUGET_PACKAGES).toBe(
      join(paths.root, 'cache', 'nuget'),
    );
    const devops = sessionEnv({ ...base, agent: { isDevops: true } }, cfg, {});
    for (const k of [
      'NUGET_PACKAGES',
      'DOTNET_CLI_HOME',
      'npm_config_cache',
      'MAVEN_OPTS',
      'MSBUILDDISABLENODEREUSE',
      'DOTNET_PROCESSOR_COUNT',
      'EnableSourceControlManagerQueries',
    ])
      expect(devops[k], k).toBeUndefined();
    expect(devops.HOME).toBe(homedir());
  });
});

describe('sandbox policy: caches, dotnet and the read-only worktree', () => {
  const ctx = policyCtx({
    sharedCacheDir: '/data/cache',
    nugetFallbackDir: '/home/me/.nuget/packages',
    dotnetShmDir: DOTNET_SHM_DIR,
  });
  const fsOf = (key: string) =>
    buildShiftSettings(role(key).permissions, ctx, POLICY_PATHS, key).sandbox?.filesystem;

  it('the shared caches and /tmp/.dotnet are writable; the NuGet fallback is read-only', () => {
    for (const key of ['builder', 'reviewer', 'tester']) {
      const fs = fsOf(key);
      expect(fs?.allowWrite, key).toEqual(expect.arrayContaining(['/data/cache', DOTNET_SHM_DIR]));
      expect(fs?.allowRead, key).toContain('/home/me/.nuget/packages');
      expect(fs?.allowWrite, key).not.toContain('/home/me/.nuget/packages');
      expect(fs?.denyWrite, key).not.toContain('/data/cache');
    }
  });

  it('nothing is shared when the runner passes no cache dirs (unit fixtures)', () => {
    const fs = buildShiftSettings(role('builder').permissions, policyCtx(), POLICY_PATHS).sandbox?.filesystem;
    expect(fs?.allowWrite).toEqual([
      '/data/agents/a1/home',
      '/data/agents/a1/scratch',
      '/data/agents/a1/tmp',
      '/home/me/toy/.git',
    ]);
  });

  it('allows the NuGet hosts so a restore can download what the caches lack', () => {
    expect(REGISTRY_DOMAINS).toEqual(expect.arrayContaining(['api.nuget.org', '*.nuget.org']));
  });

  it('read-only shift: no write into the worktree or any of its parents, caches stay writable', () => {
    const fs = fsOf('reviewer');
    const wt = ctx.cwd;
    expect(fs?.denyWrite).toContain(wt);
    for (const w of fs?.allowWrite ?? []) {
      expect(wt === w || wt.startsWith(`${w}/`), `${w} would make the worktree writable`).toBe(false);
    }
  });

  // Real failure: "bwrap: Can't create file <worktree>/.gitconfig: Read-only file system" for every command of a
  // reviewer. Masking a directory that holds the read-only cwd makes bubblewrap create Claude Code's protected
  // dotfiles inside it, which cannot be done.
  it('read-only shift: the data dir is masked entry by entry, never as a parent of the worktree', () => {
    const root = realpathSync(tmp());
    const cwd = join(root, 'worktrees', 'P-1', 'X-1');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, 'worktrees', 'P-1', 'X-2'));
    mkdirSync(join(root, 'worktrees', 'P-9', 'Y-1'), { recursive: true });
    mkdirSync(join(root, 'agents', 'a1'), { recursive: true });
    writeFileSync(join(root, 'config.json'), '{}');
    const reviewerCtx = policyCtx({ runnerRoot: root, agentDir: join(root, 'agents', 'a1'), cwd });
    const fs = buildShiftSettings(role('reviewer').permissions, reviewerCtx, POLICY_PATHS, 'reviewer').sandbox
      ?.filesystem;
    const deny = fs?.denyRead ?? [];
    for (const parent of [root, join(root, 'worktrees'), join(root, 'worktrees', 'P-1'), cwd])
      expect(deny, `${parent} must not be masked`).not.toContain(parent);
    expect(deny).toEqual(
      expect.arrayContaining([
        join(root, 'config.json'),
        join(root, 'agents'),
        join(root, 'worktrees', 'P-9'),
        join(root, 'worktrees', 'P-1', 'X-2'),
      ]),
    );
    expect(fs?.denyWrite).toContain(cwd);
    // a writable shift (builder) keeps the simple whole-data-dir mask
    const b = buildShiftSettings(role('builder').permissions, reviewerCtx, POLICY_PATHS, 'builder').sandbox
      ?.filesystem;
    expect(b?.denyRead).toContain(root);
  });

  it('denyAround masks everything when the data dir cannot be listed', () => {
    expect(denyAround('/nonexistent-aom-root', '/nonexistent-aom-root/worktrees/x')).toEqual([
      '/nonexistent-aom-root',
    ]);
  });
});

// ---------------------------------------------------------------------------------- real sandbox (bubblewrap)

const which = (bin: string): string | undefined => {
  const dirs = [...(process.env.PATH ?? '').split(':'), join(homedir(), '.dotnet')];
  return dirs.map((d) => join(d, bin)).find((p) => existsSync(p));
};
const bwrap = process.platform === 'linux' ? which('bwrap') : undefined;
const dotnet = which('dotnet');
const bwrapWorks =
  bwrap !== undefined &&
  spawnSync(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', 'true'], { encoding: 'utf8' }).status === 0;

/**
 * Runs `dotnet new console && dotnet build` under bubblewrap with the mounts of the policy the runner generates for a
 * builder (read-only root, the policy's allowWrite paths writable) and the env of `sandboxEnv`.
 */
describe.skipIf(!bwrapWorks || !dotnet || process.platform !== 'linux')(
  'dotnet in a real bubblewrap sandbox (skipped without bwrap or dotnet)',
  () => {
    const run = async (
      withShm: boolean,
      opts: { script?: string; dropEnv?: string[]; timeoutMs?: number; maskGitmodules?: boolean } = {},
    ) => {
      const root = realpathSync(tmp());
      const paths = runnerPaths(root);
      const sb = await ensureSandbox(paths, A1, 'Ada');
      const cwd = join(root, 'worktrees', 'P-1', 'X-1');
      mkdirSync(cwd, { recursive: true });
      const policy = buildShiftSettings(
        role('builder').permissions,
        policyCtx({
          runnerRoot: root,
          agentDir: paths.agentDir(A1),
          cwd,
          gitDirs: [],
          sharedCacheDir: sb.cacheRoot,
          dotnetShmDir: DOTNET_SHM_DIR,
        }),
        sb,
        'builder',
      );
      const writable = (policy.sandbox?.filesystem.allowWrite ?? []).filter(
        (p) => (withShm || p !== DOTNET_SHM_DIR) && existsSync(p),
      );
      const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
      // like the sandbox: everything (also /tmp) is read-only except the policy's writable paths
      for (const w of writable) args.push('--bind', w, w);
      args.push('--bind', cwd, cwd);
      // the sandbox runtime masks a protected path that does not exist with /dev/null
      if (opts.maskGitmodules) args.push('--ro-bind', '/dev/null', join(cwd, '.gitmodules'));
      args.push('--chdir', cwd);
      const env = {
        PATH: `${join(dotnet as string, '..')}:${process.env.PATH}`,
        DOTNET_ROOT: join(dotnet as string, '..'),
        ...sandboxEnv(sb),
      };
      for (const k of opts.dropEnv ?? []) delete (env as Record<string, string>)[k];
      const script =
        opts.script ??
        'dotnet new console -n app --no-restore >/dev/null && cd app && dotnet build 2>&1 | tail -20';
      return spawnSync(bwrap as string, [...args, 'bash', '-c', script], {
        env,
        encoding: 'utf8',
        timeout: opts.timeoutMs ?? 120_000,
      });
    };

    // card P4-7: a solution of several projects makes MSBuild start one worker node per CPU, and every node binds a
    // named pipe at the hard-coded `/tmp/MSBuild<pid>`, which the sandbox's read-only /tmp refuses (the real sandbox's
    // seccomp filter also refuses the socket itself). DOTNET_PROCESSOR_COUNT=1 keeps the build in one process.
    const multiProject = [
      'dotnet new sln -n S >/dev/null',
      'for p in A B C D; do dotnet new classlib -n $p -o $p --no-restore >/dev/null; dotnet sln add $p/$p.csproj >/dev/null; done',
      'dotnet add B/B.csproj reference A/A.csproj >/dev/null',
      'dotnet add C/C.csproj reference A/A.csproj >/dev/null',
      'dotnet add D/D.csproj reference B/B.csproj C/C.csproj >/dev/null',
      'timeout 60 dotnet build 2>&1 | tail -20',
    ].join(' && ');

    it('a plain `dotnet build` of a multi-project solution succeeds (no MSBuild worker nodes)', async () => {
      const r = await run(true, { script: multiProject, timeoutMs: 150_000 });
      expect(r.stdout, `${r.stdout}${r.stderr}`).toContain('Build succeeded');
      expect(r.stdout).not.toContain('Build FAILED');
    }, 180_000);

    it('without DOTNET_PROCESSOR_COUNT the same build fails or hangs in the sandbox (the bug)', async () => {
      const r = await run(true, {
        script: multiProject.replace('timeout 60', 'timeout 25'),
        dropEnv: ['DOTNET_PROCESSOR_COUNT'],
        timeoutMs: 150_000,
      });
      expect(`${r.stdout}${r.stderr}`).not.toContain('not a valid option'); // the setup ran, the build was tried
      expect(r.stdout).not.toContain('Build succeeded');
    }, 180_000);

    it('without write access to /tmp/.dotnet the build fails on the NuGet-Migrations mutex (the bug)', async () => {
      const r = await run(false);
      expect(r.stdout).not.toContain('Build succeeded');
      expect(`${r.stdout}${r.stderr}`).toMatch(/NuGet-Migrations|cannot open the device or file/);
    }, 150_000);

    it('with the policy mounts (/tmp/.dotnet writable, caches shared, DOTNET_CLI_HOME) dotnet build succeeds', async () => {
      const r = await run(true);
      expect(r.stdout, r.stderr).toContain('Build succeeded');
    }, 150_000);
  
    // #33: a repository without .gitmodules, whose path the sandbox masks with /dev/null
    const gitmodulesScript =
      'git init -q . && dotnet new classlib -n lib -o lib --no-restore >/dev/null && cd lib && dotnet build -nologo 2>&1 | tail -8';

    it('a build in a repository without .gitmodules succeeds (no SourceLink probe)', async () => {
      const r = await run(true, { script: gitmodulesScript, maskGitmodules: true });
      expect(r.stdout, `${r.stdout}${r.stderr}`).toContain('Build succeeded');
    }, 150_000);

    it('without EnableSourceControlManagerQueries=false the same build fails on .gitmodules (the bug)', async () => {
      const r = await run(true, {
        script: gitmodulesScript,
        maskGitmodules: true,
        dropEnv: ['EnableSourceControlManagerQueries'],
      });
      expect(r.stdout).not.toContain('Build succeeded');
      expect(`${r.stdout}${r.stderr}`).toContain('.gitmodules');
    }, 150_000);
  },
);
