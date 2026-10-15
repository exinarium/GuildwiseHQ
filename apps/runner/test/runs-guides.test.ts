import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runnerPaths } from '../src/paths.ts';
import { discoverExtraGuides, guideFolders, guidesHash } from '../src/runs/discovery.ts';
import { RunManager, type RunManagerDeps } from '../src/runs/manager.ts';
import { bwrapArgs, ServiceLauncher, userSecretsDir } from '../src/runs/sandbox.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const src = (repoId: string, clonePath: string, worktree = '/nowhere') => ({ repoId, clonePath, worktree });

describe('build guides above the repositories', () => {
  it('searches the folders above a clone up to and including the repo root that holds it, nearest first', () => {
    const root = tmp();
    const clone = join(root, 'sources', 'org', 'web');
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(root, 'sources', 'build.MD'), 'top'); // case-insensitive
    writeFileSync(join(root, 'sources', 'org', 'BUILD.md'), 'mid');
    writeFileSync(join(root, 'BUILD.md'), 'above the root: never read');
    const roots = [join(root, 'sources')];
    const folders = guideFolders(clone, roots, '/nonexistent-home');
    expect(folders).toEqual([join(root, 'sources', 'org'), join(root, 'sources')]);
    const found = discoverExtraGuides({
      sources: [src('r1', clone)],
      configured: [],
      repoRoots: roots,
      home: '/nonexistent-home',
      repoHasBuildDoc: false,
    });
    expect(found.map((g) => [g.path, g.content, g.origin])).toEqual([
      [join(root, 'sources', 'org', 'BUILD.md'), 'mid', 'parent'],
      [join(root, 'sources', 'build.MD'), 'top', 'parent'],
    ]);
  });

  it('reads nothing for a clone outside every repo root', () => {
    const root = tmp();
    const clone = join(root, 'elsewhere', 'web');
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(root, 'elsewhere', 'BUILD.md'), 'x');
    expect(guideFolders(clone, [join(root, 'sources')], '/h')).toEqual([]);
    expect(guideFolders(clone, [clone], '/h')).toEqual([]); // the clone is the root itself
  });

  it('never goes to the home directory or above it', () => {
    const home = tmp();
    const clone = join(home, 'src', 'org', 'web');
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(home, 'BUILD.md'), 'home guide');
    writeFileSync(join(home, 'src', 'BUILD.md'), 'src guide');
    // a root that is the home directory (or above): the walk stops before it
    expect(guideFolders(clone, [home], home)).toEqual([join(home, 'src', 'org'), join(home, 'src')]);
    const found = discoverExtraGuides({
      sources: [src('r1', clone)],
      configured: [],
      repoRoots: [home],
      home,
      repoHasBuildDoc: false,
    });
    expect(found.map((g) => g.content)).toEqual(['src guide']);
    // a home that sits inside the root: the walk stops there too
    expect(guideFolders(clone, [home], join(home, 'src'))).toEqual([join(home, 'src', 'org')]);
  });

  it('lists a guide once for several repositories, with the repositories it applies to', () => {
    const root = tmp();
    const a = join(root, 'sources', 'a');
    const b = join(root, 'sources', 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(root, 'sources', 'BUILD.md'), 'shared');
    writeFileSync(join(b, 'x'), '');
    const found = discoverExtraGuides({
      sources: [src('ra', a), src('rb', b)],
      configured: [],
      repoRoots: [join(root, 'sources')],
      home: '/h',
      repoHasBuildDoc: false,
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ content: 'shared', repoIds: ['ra', 'rb'] });
  });

  it('the configured guides replace discovery', () => {
    const root = tmp();
    const clone = join(root, 'sources', 'web');
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(root, 'sources', 'BUILD.md'), 'parent');
    const mine = join(root, 'my-guide.md');
    writeFileSync(mine, 'mine');
    const found = discoverExtraGuides({
      sources: [src('r1', clone)],
      configured: [mine, join(root, 'missing.md'), mine],
      repoRoots: [join(root, 'sources')],
      home: '/h',
      repoHasBuildDoc: false,
    });
    expect(found).toEqual([{ path: mine, content: 'mine', origin: 'configured', repoIds: ['r1'] }]);
  });

  it('falls back to README files only when no BUILD.md exists anywhere', () => {
    const root = tmp();
    const clone = join(root, 'sources', 'web');
    const wt = join(root, 'wt');
    mkdirSync(clone, { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, 'README.md'), 'repo readme');
    writeFileSync(join(root, 'sources', 'readme.txt'), 'folder readme');
    const base = {
      sources: [{ repoId: 'r1', clonePath: clone, worktree: wt }],
      configured: [],
      repoRoots: [join(root, 'sources')],
      home: '/h',
    };
    const readmes = discoverExtraGuides({ ...base, repoHasBuildDoc: false });
    expect(readmes.map((g) => [g.origin, g.content])).toEqual([
      ['readme', 'repo readme'],
      ['readme', 'folder readme'],
    ]);
    // a BUILD.md in a repository: no README fallback
    expect(discoverExtraGuides({ ...base, repoHasBuildDoc: true })).toEqual([]);
    // a BUILD.md above the repositories: only that one
    writeFileSync(join(root, 'sources', 'BUILD.md'), 'build');
    expect(discoverExtraGuides({ ...base, repoHasBuildDoc: false }).map((g) => g.origin)).toEqual(['parent']);
  });

  it('the fingerprint covers the guides above the repositories, and is unchanged when there are none', () => {
    const docs = [{ repoId: 'r1', content: 'in repo' }];
    const parent = { path: '/s/BUILD.md', content: 'v1', origin: 'parent' as const };
    expect(guidesHash(docs)).toBe(guidesHash(docs, []));
    expect(guidesHash(docs, [parent])).not.toBe(guidesHash(docs));
    expect(guidesHash(docs, [parent])).not.toBe(guidesHash(docs, [{ ...parent, content: 'v2' }]));
    expect(guidesHash(docs, [parent])).not.toBe(guidesHash(docs, [{ ...parent, path: '/t/BUILD.md' }]));
    // a README is only a fallback: editing it does not make a plan stale
    const readme = { path: '/s/README.md', content: 'a', origin: 'readme' as const };
    expect(guidesHash(docs, [readme])).toBe(guidesHash(docs, [{ ...readme, content: 'b' }]));
  });
});

describe('service sandbox: .NET user secrets', () => {
  const spec = {
    runnerRoot: '/nonexistent/.aom-runner',
    realHome: '/nonexistent-home',
    worktrees: ['/nonexistent/wt'],
    cacheRoot: '/nonexistent/cache',
    runTmp: '/tmp/aom-run-x',
    uid: 1000,
  };

  it('shows ~/.microsoft/usersecrets read-only at the services HOME when it exists', () => {
    const home = tmp();
    mkdirSync(join(home, '.microsoft', 'usersecrets', 'abc'), { recursive: true });
    const args = bwrapArgs({ ...spec, realHome: home });
    const i = args.findIndex((x, k) => x === '--ro-bind' && args[k + 1] === userSecretsDir(home));
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 2]).toBe('/tmp/home/.microsoft/usersecrets');
    // after the private /tmp is bound, so the target exists inside it
    expect(i).toBeGreaterThan(args.indexOf('--bind'));
    // nothing else of the home gets such a bind, and it is never writable
    expect(args.some((x, k) => x === '--bind' && args[k + 1] === userSecretsDir(home))).toBe(false);
  });

  it('adds nothing when the folder does not exist', () => {
    const args = bwrapArgs({ ...spec, realHome: tmp() });
    expect(args.join(' ')).not.toContain('usersecrets');
  });
});

/** Run worktrees: build guides from above the clone, and submodules. */
function setup(over: Partial<RunManagerDeps> = {}) {
  const repo = makeRepo();
  const root = tmp();
  const paths = runnerPaths(root);
  mkdirSync(paths.worktrees, { recursive: true });
  const mgr = new RunManager({
    paths,
    findRepo: async () => ({ localPath: repo.clone }),
    send: () => {},
    log: { info() {}, warn() {}, error() {} },
    maxEnvironments: () => 2,
    launcher: new ServiceLauncher({ noScope: true }),
    portRange: () => ({ from: 43000, to: 43400 }),
    repoRoots: () => [repo.scanRoot],
    realHome: '/nonexistent-home',
    ...over,
  });
  const repoId = randomUUID();
  const start = (extra: Record<string, unknown> = {}) => {
    const envId = randomUUID();
    return {
      envId,
      p: {
        envId,
        projectId: randomUUID(),
        projectKey: 'TOY',
        projectName: 'Toy',
        purpose: 'manual' as const,
        requestId: randomUUID(),
        sources: [{ repoId, name: 'toy', remoteUrlNormalized: repo.remoteNormalized, branch: 'main' }],
        services: [],
        portRange: { from: 43000, to: 43400 },
        ttlAt: new Date(Date.now() + 3600_000).toISOString(),
        allowDocker: false,
        ...extra,
      },
    };
  };
  return { repo, mgr, repoId, start };
}

const mgrs: RunManager[] = [];
afterEach(async () => {
  for (const m of mgrs.splice(0)) {
    for (const id of m.liveEnvIds()) await m.stop({ envId: id, reason: 'stopped' });
    m.shutdown();
  }
});

describe('the run manager and the guides', () => {
  it('gives the DevOps brief the BUILD.md above the clone with its absolute path, and maps checkout to worktree', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    writeFileSync(
      join(t.repo.scanRoot, 'BUILD.md'),
      '# Build everything\nrun the webconsole embedded server\n',
    );
    const { p, envId } = t.start();
    expect(await t.mgr.startEnv(p)).toEqual({ ok: true });
    const { guides, pathMap } = await t.mgr.buildGuides(envId);
    expect(guides).toEqual([
      {
        path: join(t.repo.scanRoot, 'BUILD.md'),
        content: '# Build everything\nrun the webconsole embedded server\n',
        origin: 'parent',
        repoIds: [t.repoId],
      },
    ]);
    expect(pathMap).toHaveLength(1);
    expect(pathMap[0]).toMatchObject({ repoId: t.repoId, clonePath: t.repo.clone });
    expect(pathMap[0]?.worktreePath).toContain('run-');
  });

  it('uses the Build guide setting instead of discovery (and ignores the repository BUILD.md)', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    writeFileSync(join(t.repo.scanRoot, 'BUILD.md'), 'parent');
    writeFileSync(join(t.repo.clone, 'BUILD.md'), 'in repo');
    sh(t.repo.clone, 'git', ['add', '-A']);
    sh(t.repo.clone, 'git', ['commit', '-m', 'build']);
    const mine = join(tmp(), 'guide.md');
    writeFileSync(mine, 'my guide');
    const { p, envId } = t.start({ buildGuides: [mine] });
    await t.mgr.startEnv(p);
    const { guides } = await t.mgr.buildGuides(envId);
    expect(guides.map((g) => [g.origin, g.content])).toEqual([['configured', 'my guide']]);
    expect(await t.mgr.buildDocs(envId)).toEqual([]);
  });

  it('keeps the repository BUILD.md next to the one above it', async () => {
    const t = setup();
    mgrs.push(t.mgr);
    writeFileSync(join(t.repo.scanRoot, 'BUILD.md'), 'parent');
    writeFileSync(join(t.repo.clone, 'BUILD.md'), 'in repo');
    sh(t.repo.clone, 'git', ['add', '-A']);
    sh(t.repo.clone, 'git', ['commit', '-m', 'build']);
    const { p, envId } = t.start();
    await t.mgr.startEnv(p);
    expect((await t.mgr.buildDocs(envId)).map((d) => d.content)).toEqual(['in repo']);
    expect((await t.mgr.buildGuides(envId)).guides.map((g) => g.content)).toEqual(['parent']);
  });

  it('initialises the submodules of a run worktree with the repository git auth', async () => {
    const prev = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
    };
    // the test submodule lives on the local file system
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow';
    process.env.GIT_CONFIG_VALUE_0 = 'always';
    try {
      const authFor: string[] = [];
      const t = setup({
        gitAuth: async (url) => {
          authFor.push(url);
          return { args: [], env: {} };
        },
      });
      mgrs.push(t.mgr);
      const sub = makeRepo();
      writeFileSync(join(sub.clone, 'embedded.txt'), 'embedded server\n');
      sh(sub.clone, 'git', ['add', '-A']);
      sh(sub.clone, 'git', ['commit', '-m', 'embedded']);
      sh(t.repo.clone, 'git', ['submodule', 'add', sub.clone, 'modules/server']);
      sh(t.repo.clone, 'git', ['commit', '-m', 'add the submodule']);
      const { p, envId } = t.start();
      expect(await t.mgr.startEnv(p)).toEqual({ ok: true });
      const { pathMap } = await t.mgr.buildGuides(envId);
      const wt = pathMap[0]?.worktreePath as string;
      expect(readFileSync(join(wt, 'modules', 'server', 'embedded.txt'), 'utf8')).toBe('embedded server\n');
      expect(authFor).toEqual([t.repo.origin]);
      // removing the environment removes the worktree with its submodule
      await t.mgr.stop({ envId, reason: 'stopped' });
      expect(existsSync(wt)).toBe(false);
    } finally {
      for (const [k, v] of Object.entries({
        GIT_CONFIG_COUNT: prev.count,
        GIT_CONFIG_KEY_0: prev.key,
        GIT_CONFIG_VALUE_0: prev.value,
      }))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });

  it('a worktree whose submodules cannot be fetched still starts, and the DevOps engineer is told', async () => {
    const prev = [process.env.GIT_CONFIG_COUNT, process.env.GIT_CONFIG_KEY_0, process.env.GIT_CONFIG_VALUE_0];
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'protocol.file.allow';
    process.env.GIT_CONFIG_VALUE_0 = 'always';
    try {
      const t = setup();
      mgrs.push(t.mgr);
      const sub = makeRepo();
      sh(t.repo.clone, 'git', ['submodule', 'add', sub.clone, 'modules/server']);
      sh(t.repo.clone, 'git', ['commit', '-m', 'add the submodule']);
      rmSync(sub.root, { recursive: true, force: true }); // the submodule's remote is gone
      const { p, envId } = t.start();
      expect(await t.mgr.startEnv(p)).toEqual({ ok: true });
      const info = (await t.mgr.rpc(envId, 'run.info', {}, { requestId: p.requestId, declared: [] })) as any;
      expect(info.result.message).toContain('WARNING: the submodules could not be initialised');
    } finally {
      const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'];
      keys.forEach((k, i) => {
        const v = prev[i];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      });
    }
  });
});
