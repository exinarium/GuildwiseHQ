import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReleaseDocsPrepPayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { runReleaseDocsPrep } from '../src/git/release-docs-prep.ts';
import {
  type DocsPrepSandboxDeps,
  type DocsPrepSpawner,
  docsPrepEnv,
  machineDataDir,
  sandboxedDocsPrepExec,
} from '../src/git/release-docs-prep-exec.ts';
import { type DocsPrepExecScope, DocsPrepSandboxError } from '../src/git/release-docs-prep-steps.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const RUN = '019e3f6a-7b1c-7a2d-8c3e-0123456789f1';
const ID = (n: number) => `019e3f6a-7b1c-7a2d-8c3e-01234567890${n}`;

const PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  HOME: '/home/u',
  GH_TOKEN: 'ghp_secret',
  AOM_RUNNER_TOKEN: 'secret',
  AOM_FFMPEG: '/opt/ffmpeg',
  AOM_E2E_PG_HOSTPORT: '127.0.0.1:5433',
  SSH_AUTH_SOCK: '/tmp/ssh.sock',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  ANTHROPIC_API_KEY: 'x',
};

interface Call {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

function world() {
  const home = tmp();
  mkdirSync(join(home, '.ssh'));
  writeFileSync(join(home, '.npmrc'), '//registry/:_authToken=x');
  mkdirSync(join(home, '.aws'));
  const machine = tmp();
  const root = join(machine, 'pairings', 'p1');
  mkdirSync(join(machine, 'pairings', 'other'), { recursive: true });
  mkdirSync(join(root, 'secrets'), { recursive: true });
  const worktree = join(root, 'integration', 'wt');
  mkdirSync(join(worktree, 'docs'), { recursive: true });
  const outDir = tmp('docs-prep-guide-');
  return { home, machine, root, worktree, outDir, cacheRoot: join(root, 'cache'), tmpRoot: tmp() };
}

function deps(
  w: ReturnType<typeof world>,
  over: Partial<DocsPrepSandboxDeps> = {},
  result: Awaited<ReturnType<DocsPrepSpawner>> = { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false },
) {
  const calls: Call[] = [];
  const logs: string[] = [];
  let probes = 0;
  const d: DocsPrepSandboxDeps = {
    runnerRoot: w.root,
    realHome: w.home,
    cacheRoot: w.cacheRoot,
    launcher: {
      sandboxAvailable: async () => {
        probes++;
        return true;
      },
    },
    toolchains: () => ({ pathDirs: ['/opt/node/bin'], env: { DOTNET_ROOT: '/opt/dotnet', NPM_TOKEN: 'x' } }),
    spawn: async (cmd, args, o) => {
      calls.push({ cmd, args, cwd: o.cwd, env: o.env });
      return result;
    },
    log: { info: (m) => logs.push(m) },
    platform: 'linux',
    parentEnv: PARENT_ENV,
    tmpRoot: w.tmpRoot,
    ...over,
  };
  return { d, calls, logs, probes: () => probes };
}

const scopeOf = (w: ReturnType<typeof world>, over: Partial<DocsPrepExecScope> = {}): DocsPrepExecScope => ({
  step: 'guide',
  phase: 'apply',
  worktree: w.worktree,
  outDir: w.outDir,
  runId: RUN,
  repoId: ID(3),
  ...over,
});

const binds = (args: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--bind') out.push(`${args[i + 1]}->${args[i + 2]}`);
  return out;
};
const has = (args: string[], ...seq: string[]): boolean =>
  args.some((_, i) => seq.every((s, k) => args[i + k] === s));

describe('docs-prep exec: every project command runs in the bubblewrap sandbox', () => {
  it('runs the guide build as one bwrap spawn with the worktree and scratch folder writable', async () => {
    const w = world();
    const t = deps(w);
    const exec = sandboxedDocsPrepExec(t.d)(scopeOf(w));
    const r = await exec('node', ['docs/guide/build-guide.mjs', '--date', '2026-11-16'], {
      cwd: w.worktree,
      timeoutMs: 60_000,
    });
    expect(r).toEqual({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false });
    expect(t.calls).toHaveLength(1);
    const c = t.calls[0] as Call;
    expect(c.cmd).toBe('bwrap');
    expect(c.args.slice(-5)).toEqual(['--', 'node', 'docs/guide/build-guide.mjs', '--date', '2026-11-16']);
    expect(c.cwd).toBe(w.worktree);
    const b = binds(c.args);
    expect(b).toContain(`${w.worktree}->${w.worktree}`);
    expect(b).toContain(`${w.outDir}->${w.outDir}`);
    expect(b).toContain(`${w.cacheRoot}->${w.cacheRoot}`);
    expect(b.find((x) => x.endsWith('->/tmp'))?.startsWith(`${w.tmpRoot}/aom-docsprep-`)).toBe(true);
    // only those four writable binds
    expect(b).toHaveLength(4);
    expect(c.args).toContain('--die-with-parent');
    expect(c.args).not.toContain('--unshare-net'); // the host network, as run steps
    expect(c.args.join(' ')).not.toContain('usersecrets');
    // the machine data dir (sibling pairings), the runner root and the credential files are masked
    expect(has(c.args, '--tmpfs', w.machine)).toBe(true);
    expect(has(c.args, '--tmpfs', w.root)).toBe(true);
    expect(has(c.args, '--tmpfs', join(w.home, '.ssh'))).toBe(true);
    expect(has(c.args, '--tmpfs', join(w.home, '.aws'))).toBe(true);
    expect(has(c.args, '--ro-bind', '/dev/null', join(w.home, '.npmrc'))).toBe(true);
    expect(t.logs[0]).toMatch(
      /release prep guide\/apply: node docs\/guide\/build-guide\.mjs .*\(sandboxed: bwrap\)/,
    );
    // the private tmp dir is gone afterwards
    const runTmp = (b.find((x) => x.endsWith('->/tmp')) as string).split('->')[0] as string;
    expect(existsSync(runTmp)).toBe(false);
  });

  it('runs the assistant-pack commands through the same profile', async () => {
    const w = world();
    const t = deps(w);
    const exec = sandboxedDocsPrepExec(t.d)(scopeOf(w, { step: 'assistant-pack', phase: '' }));
    await exec('corepack', ['pnpm', 'install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: w.worktree,
      timeoutMs: 1000,
    });
    await exec('corepack', ['pnpm', '--filter', '@aom/server', 'assistant:pack'], {
      cwd: w.worktree,
      timeoutMs: 1000,
    });
    expect(t.calls.map((c) => c.cmd)).toEqual(['bwrap', 'bwrap']);
    expect(t.calls[1]?.args.slice(-6)).toEqual([
      '--',
      'corepack',
      'pnpm',
      '--filter',
      '@aom/server',
      'assistant:pack',
    ]);
    expect(binds(t.calls[1]?.args ?? [])).toContain(`${w.worktree}->${w.worktree}`);
    expect(has(t.calls[1]?.args ?? [], '--tmpfs', w.machine)).toBe(true);
    expect(t.logs[0]).toContain('release prep assistant-pack: corepack pnpm install');
  });

  it('gives a scrubbed environment: no runner variables, tokens or session sockets; private HOME; shared caches', async () => {
    const w = world();
    const t = deps(w);
    await sandboxedDocsPrepExec(t.d)(scopeOf(w))('node', ['x.mjs'], { cwd: w.worktree, timeoutMs: 1000 });
    const env = t.calls[0]?.env as Record<string, string>;
    expect(Object.keys(env).filter((k) => k.startsWith('AOM_'))).toEqual([]);
    for (const k of [
      'GH_TOKEN',
      'NPM_TOKEN',
      'SSH_AUTH_SOCK',
      'DBUS_SESSION_BUS_ADDRESS',
      'ANTHROPIC_API_KEY',
    ])
      expect(env[k]).toBeUndefined();
    expect(env.HOME).toBe('/tmp/home');
    expect(env.TMPDIR).toBe('/tmp');
    expect(env.LANG).toBe('C.UTF-8');
    expect(env.DOTNET_ROOT).toBe('/opt/dotnet');
    expect(env.PATH?.split(':')[0]).toBe('/opt/node/bin');
    expect(env.PATH?.split(':')).toContain('/usr/bin');
    expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe(join(w.cacheRoot, 'ms-playwright'));
    expect(env.COREPACK_HOME).toBe(join(w.cacheRoot, 'corepack'));
    expect(env.pnpm_config_store_dir).toBe(join(w.cacheRoot, 'pnpm'));
    expect(existsSync(join(w.cacheRoot, 'ms-playwright'))).toBe(true);
    expect(existsSync(join(w.cacheRoot, 'corepack'))).toBe(true);
  });

  it('passes the video tool variables to the videos step only, and binds its voice folder read-write', async () => {
    const w = world();
    const videoHome = tmp('aom-video-');
    const t = deps(w, { parentEnv: { ...PARENT_ENV, AOM_VIDEO_HOME: videoHome } });
    const exec = sandboxedDocsPrepExec(t.d)(scopeOf(w, { step: 'videos', phase: 'render' }));
    await exec('pnpm', ['build'], { cwd: w.worktree, timeoutMs: 1000, env: { AOM_VIDEO_SLUG: 'backlog' } });
    const env = t.calls[0]?.env as Record<string, string>;
    expect(env.AOM_VIDEO_HOME).toBe(videoHome);
    expect(env.AOM_FFMPEG).toBe('/opt/ffmpeg');
    expect(env.AOM_E2E_PG_HOSTPORT).toBe('127.0.0.1:5433');
    expect(env.AOM_VIDEO_SLUG).toBe('backlog');
    expect(env.AOM_RUNNER_TOKEN).toBeUndefined();
    expect(binds(t.calls[0]?.args ?? [])).toContain(`${videoHome}->${videoHome}`);
    // the guide step gets neither
    const g = docsPrepEnv(
      { ...t.d, parentEnv: { ...PARENT_ENV, AOM_VIDEO_HOME: videoHome } },
      { step: 'guide' },
    );
    expect(g.AOM_VIDEO_HOME).toBeUndefined();
    expect(g.AOM_FFMPEG).toBeUndefined();
  });

  it('the voice folder defaults to ~/.cache/aom-video', () => {
    const w = world();
    const t = deps(w);
    expect(docsPrepEnv(t.d, { step: 'videos' }).AOM_VIDEO_HOME).toBe(join(w.home, '.cache', 'aom-video'));
  });

  it('lets a command run in its scratch folder too, but nowhere else', async () => {
    const w = world();
    const t = deps(w);
    const exec = sandboxedDocsPrepExec(t.d)(scopeOf(w));
    await exec('true', [], { cwd: w.outDir, timeoutMs: 1000 });
    expect(t.calls).toHaveLength(1);
    for (const cwd of [w.home, w.root, join(w.worktree, '..'), join(w.worktree, 'missing')])
      await expect(exec('true', [], { cwd, timeoutMs: 1000 })).rejects.toBeInstanceOf(DocsPrepSandboxError);
    expect(t.calls).toHaveLength(1);
  });

  it('machineDataDir is the folder above pairings/<id>, else the runner root', () => {
    expect(machineDataDir('/h/.aom-runner/pairings/x')).toBe('/h/.aom-runner');
    expect(machineDataDir('/h/.aom-runner')).toBe('/h/.aom-runner');
  });
});

describe('docs-prep exec: fails closed', () => {
  it('bubblewrap unavailable: rejects naming the step and the reason, and never spawns', async () => {
    const w = world();
    const t = deps(w, { launcher: { sandboxAvailable: async () => false } });
    const exec = sandboxedDocsPrepExec(t.d)(scopeOf(w));
    const err = await exec('node', ['docs/guide/build-guide.mjs'], {
      cwd: w.worktree,
      timeoutMs: 1000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DocsPrepSandboxError);
    expect(err.message).toContain("release prep step 'guide/apply'");
    expect(err.message).toContain('bubblewrap sandbox is not available');
    expect(err.message).toContain('The command was not run');
    expect(t.calls).toHaveLength(0);
  });

  it('not Linux: rejects naming the platform, and never spawns', async () => {
    const w = world();
    const t = deps(w, { platform: 'darwin' });
    const exec = sandboxedDocsPrepExec(t.d)(scopeOf(w, { step: 'assistant-pack', phase: '' }));
    const err = await exec('corepack', ['pnpm'], { cwd: w.worktree, timeoutMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(DocsPrepSandboxError);
    expect(err.message).toMatch(
      /release prep step 'assistant-pack' needs the Linux bubblewrap sandbox.*darwin/,
    );
    expect(t.calls).toHaveLength(0);
    expect(t.probes()).toBe(0);
  });

  it('a bubblewrap setup error after the spawn is a sandbox error, not a command failure', async () => {
    const w = world();
    const t = deps(
      w,
      {},
      {
        exitCode: 1,
        stdout: '',
        stderr: "bwrap: Can't mkdir /x: Permission denied\n",
        timedOut: false,
      },
    );
    const err = await sandboxedDocsPrepExec(t.d)(scopeOf(w))('node', ['a'], {
      cwd: w.worktree,
      timeoutMs: 1000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DocsPrepSandboxError);
    expect(err.message).toContain("could not start node in the sandbox: bwrap: Can't mkdir /x");
  });

  it('bwrap that cannot be spawned at all is a sandbox error', async () => {
    const w = world();
    const t = deps(
      w,
      {},
      { exitCode: 127, stdout: '', stderr: '', timedOut: false, spawnError: 'spawn bwrap ENOENT' },
    );
    await expect(
      sandboxedDocsPrepExec(t.d)(scopeOf(w))('node', ['a'], { cwd: w.worktree, timeoutMs: 1000 }),
    ).rejects.toThrow(/could not start the bubblewrap sandbox for node: spawn bwrap ENOENT/);
  });

  it("a command's own failure and timeout are returned as they are", async () => {
    const w = world();
    const t = deps(w, {}, { exitCode: 2, stdout: '', stderr: 'Error: boom', timedOut: false });
    const r = await sandboxedDocsPrepExec(t.d)(scopeOf(w))('node', ['a'], {
      cwd: w.worktree,
      timeoutMs: 1000,
    });
    expect(r).toEqual({ exitCode: 2, stdout: '', stderr: 'Error: boom', timedOut: false });
    const t2 = deps(w, {}, { exitCode: 143, stdout: '', stderr: '', timedOut: true });
    const r2 = await sandboxedDocsPrepExec(t2.d)(scopeOf(w))('node', ['a'], {
      cwd: w.worktree,
      timeoutMs: 1,
    });
    expect(r2.timedOut).toBe(true);
  });
});

// ----------------------------------------------------------------------------------------------- through the framework

const GENERATOR = 'apps/server/scripts/build-assistant-pack.ts';

function write(dir: string, path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function repoWithPack() {
  const repo = makeRepo();
  write(repo.clone, GENERATOR, '// builds the pack\n');
  write(repo.clone, 'apps/server/src/assistant/pack/topics/desk.md', 'old\n');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'chore: start']);
  sh(repo.clone, 'git', ['tag', '-a', 'v1.4.0', '-m', '1.4.0']);
  sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
  sh(repo.clone, 'git', ['checkout', '-b', 'release/1.5.0']);
  write(repo.clone, 'README.md', 'x\n');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'docs: readme']);
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'release/1.5.0']);
  return { repo, integrationDir: tmp('aom-integration-') };
}

const packPayload = (s: ReturnType<typeof repoWithPack>): ReleaseDocsPrepPayload => ({
  runId: RUN,
  projectId: ID(2),
  repoId: ID(3),
  remoteUrlNormalized: s.repo.remoteNormalized,
  releaseBranch: 'release/1.5.0',
  mainBranch: 'main',
  step: 'assistant-pack',
  components: [],
  projectKey: 'GWP',
  commitAs: { name: 'Release Owner', email: 'owner@example.test' },
});

describe('release docs prep with the sandboxed exec', () => {
  it('a step whose sandbox cannot start fails with the message, keeps nothing and cleans up', async () => {
    const s = repoWithPack();
    const scopes: DocsPrepExecScope[] = [];
    const w = world();
    const t = deps(w, { launcher: { sandboxAvailable: async () => false } });
    const factory = sandboxedDocsPrepExec(t.d);
    const r = await runReleaseDocsPrep({
      payload: packPayload(s),
      repoPath: s.repo.clone,
      integrationDir: s.integrationDir,
      execFor: (scope) => {
        scopes.push(scope);
        return factory(scope);
      },
    });
    expect(r.ok).toBe(false);
    expect(r.state).toBe('failed');
    expect(r.error).toContain("release prep step 'assistant-pack' cannot run corepack");
    expect(r.error).toContain('bubblewrap');
    expect(t.calls).toHaveLength(0);
    // nothing kept on the work ref, the worktree and scratch folder are gone
    expect(sh(s.repo.clone, 'git', ['for-each-ref', `refs/guildwise/docs-prep/${RUN}/work`])).toBe('');
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ step: 'assistant-pack', phase: '', runId: RUN, repoId: ID(3) });
    expect(scopes[0]?.worktree.startsWith(s.integrationDir)).toBe(true);
    expect(existsSync(scopes[0]?.outDir as string)).toBe(false);
    expect(sh(s.repo.clone, 'git', ['worktree', 'list'])).not.toContain('docs-prep-');
  });
});
