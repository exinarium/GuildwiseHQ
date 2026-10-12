import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES, renderChatInstructions, renderReadableFolders, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeChatCommand, buildClaudeCommand } from '../src/adapters/claude-code.ts';
import { buildChatSettings, buildShiftSettings } from '../src/adapters/claude-policy.ts';
import {
  isSecretFileName,
  SECRET_FILE_GLOBS,
  sandboxReadEntries,
  secretReadDenies,
} from '../src/adapters/read-only-dirs.ts';
import type { ChatStartInput } from '../src/adapters/types.ts';
import { ClaudeRuntimeConfigSchema } from '../src/config.ts';
import { scanAllRepos, withRemote } from '../src/git/repo-scan.ts';
import { resolveReadRepos } from '../src/read-repos.ts';
import { Runner } from '../src/runner.ts';
import { FakeServer } from './fake-server.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeConfig, makeRepo, sh, tmp, waitUntil } from './helpers.ts';
import { POLICY_PATHS, policyCtx } from './policy-fixtures.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
if (!builder) throw new Error('role');

/** A reference repository on disk with a secret at the top and in a sub folder. */
function fixtureRepo(): string {
  const dir = tmp('aom-ref-');
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# ref\n');
  writeFileSync(join(dir, '.env'), 'TOKEN=1\n');
  writeFileSync(join(dir, 'docs', 'a.md'), 'a\n');
  writeFileSync(join(dir, 'src', 'index.ts'), 'x\n');
  writeFileSync(join(dir, 'src', 'deep', 'server.pem'), 'k\n');
  writeFileSync(join(dir, 'src', 'deep', 'ok.ts'), 'y\n');
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'z\n');
  return dir;
}

describe('secret files in read-only folders', () => {
  it('matches env files, keys and credential files and nothing ordinary', () => {
    for (const n of [
      '.env',
      '.env.local',
      '.env.production',
      'a.pem',
      'tls.key',
      'id_rsa',
      'id_ed25519.pub',
      '.npmrc',
    ])
      expect(isSecretFileName(n), n).toBe(true);
    for (const n of ['env.ts', 'environment.md', 'keyboard.ts', 'identity.ts', 'README.md', 'pem.md'])
      expect(isSecretFileName(n), n).toBe(false);
  });

  it('opens a folder to the shell entry by entry, without the secret files', () => {
    const dir = fixtureRepo();
    const entries = sandboxReadEntries(dir) ?? [];
    expect(entries).toContain(join(dir, 'README.md'));
    expect(entries).toContain(join(dir, 'docs')); // a clean sub folder is opened whole
    expect(entries).toContain(join(dir, 'node_modules')); // opaque, not scanned
    expect(entries).toContain(join(dir, 'src', 'index.ts'));
    expect(entries).toContain(join(dir, 'src', 'deep', 'ok.ts'));
    expect(entries).not.toContain(dir);
    expect(entries).not.toContain(join(dir, 'src'));
    expect(entries.some((e) => e.endsWith('.env') || e.endsWith('.pem'))).toBe(false);
  });

  it('opens a clean folder as a whole, and a repository metadata folder without scanning it', () => {
    const clean = tmp('aom-clean-');
    writeFileSync(join(clean, 'a.txt'), 'a');
    expect(sandboxReadEntries(clean)).toEqual([clean]);
    const meta = join(fixtureRepo(), '.git');
    mkdirSync(meta, { recursive: true });
    writeFileSync(join(meta, 'x.key'), 'k');
    expect(sandboxReadEntries(meta)).toEqual([meta]);
  });

  it('builds a Read deny rule per secret glob and folder', () => {
    const rules = secretReadDenies(['/src/ref']);
    expect(rules).toHaveLength(SECRET_FILE_GLOBS.length);
    expect(rules).toContain('Read(//src/ref/**/.env)');
    expect(rules).toContain('Read(//src/ref/**/.env.*)');
    expect(rules).toContain('Read(//src/ref/**/*.pem)');
  });
});

describe('policy: read-only folders', () => {
  const ref = fixtureRepo();
  const ctx = policyCtx({ readDirs: [ref] });

  it('a card shift reads them, cannot write them and cannot read their secrets', () => {
    const s = buildShiftSettings(builder.permissions, ctx, POLICY_PATHS, 'builder');
    expect(s.permissions.additionalDirectories).toContain(ref);
    expect(s.permissions.deny).toContain(`Edit(//${ref.slice(1)}/**)`);
    expect(s.permissions.deny).toContain(`Read(//${ref.slice(1)}/**/.env)`);
    expect(s.permissions.deny).toContain(`Read(//${ref.slice(1)}/**/*.key)`);
    // no allow rule can write there: the builder's Edit is limited to the worktree
    expect(
      s.permissions.allow.filter((r) => r.startsWith('Edit(')).every((r) => r.includes('/data/worktrees')),
    ).toBe(true);
    const fs = s.sandbox?.filesystem;
    expect(fs?.denyWrite).toContain(ref);
    expect(fs?.allowWrite).not.toContain(ref);
    expect(fs?.allowRead).toContain(join(ref, 'README.md'));
    expect(fs?.allowRead).toContain(join(ref, 'docs'));
    expect(fs?.allowRead).not.toContain(ref);
    expect(fs?.allowRead.some((p) => p.endsWith('.env') || p.endsWith('.pem'))).toBe(false);
    // the data dir stays hidden
    expect(fs?.denyRead).toContain('/data');
  });

  it('a chat gets the same, and the card repository metadata is read-only there', () => {
    const meta = '/home/me/toy/.git';
    const s = buildChatSettings(true, [], policyCtx({ readDirs: [ref, meta], gitDirs: [] }), POLICY_PATHS);
    expect(s.permissions.additionalDirectories).toEqual(expect.arrayContaining([ref, meta]));
    expect(s.permissions.deny).toContain(`Edit(//${ref.slice(1)}/**)`);
    expect(s.permissions.deny).toContain('Edit(//home/me/toy/.git/**)');
    expect(s.permissions.deny).toContain(`Read(//${ref.slice(1)}/**/.env.*)`);
    expect(s.sandbox?.filesystem.allowWrite).not.toContain(meta);
    expect(s.sandbox?.filesystem.denyWrite).toEqual(expect.arrayContaining([ref, meta]));
    expect(s.sandbox?.filesystem.allowRead).toContain(meta);
  });

  it('without read-only folders nothing changes: no extra directories, rules or allowed reads', () => {
    const plain = buildShiftSettings(builder.permissions, policyCtx(), POLICY_PATHS, 'builder');
    expect(plain.permissions.additionalDirectories).toEqual([POLICY_PATHS.scratch, '/home/me/toy/.git']);
    expect(plain.permissions.deny.some((r) => r.includes('/**/.env'))).toBe(false);
    expect(plain.sandbox?.filesystem.allowRead).toEqual(['/data/worktrees/TOY-0192abcd/TOY-1', '/data/bin']);
  });

  it('takes a role wide list (many repositories) the same way', () => {
    const many = [fixtureRepo(), fixtureRepo(), fixtureRepo()];
    const s = buildShiftSettings(builder.permissions, policyCtx({ readDirs: many }), POLICY_PATHS, 'builder');
    for (const d of many) {
      expect(s.sandbox?.filesystem.denyWrite).toContain(d);
      expect(s.permissions.deny).toContain(`Edit(//${d.slice(1)}/**)`);
    }
  });

  it('passes the folders to claude as --add-dir, in shifts and in chats', () => {
    const cfg = ClaudeRuntimeConfigSchema.parse({});
    const chat = buildClaudeChatCommand(
      {
        chatId: 'c1',
        message: 'hi',
        cwd: '/s',
        sandbox: POLICY_PATHS,
        agent: { model: 'sonnet' } as ChatStartInput['agent'],
        env: {},
        readOnly: false,
        readDirs: ['/src/a', '/src/b'],
      },
      cfg,
    );
    expect(chat.args.join(' ')).toContain('--add-dir /src/a --add-dir /src/b');
    const shift = buildClaudeCommand(
      {
        shiftId: 's',
        prompt: 'p',
        instructionsMarkdown: '',
        cwd: '/w',
        sandbox: POLICY_PATHS,
        agent: { model: 'sonnet' } as ChatStartInput['agent'],
        env: {},
        addDirs: ['/vault'],
        readDirs: ['/src/a'],
        maxShiftMinutes: 5,
      },
      cfg,
    );
    expect(shift.args.join(' ')).toContain('--add-dir /vault --add-dir /src/a');
  });
});

describe('resolveReadRepos', () => {
  const remote = (n: string, kind: 'project' | 'reference' = 'reference') => ({
    repoId: uuidv7(),
    name: n,
    remoteUrlNormalized: `example.com/${n}`,
    kind,
  });

  it('opens only clones this workstation has, once each, as real paths', async () => {
    const a = fixtureRepo();
    const link = join(tmp('aom-link-'), 'alias');
    symlinkSync(a, link);
    const paths: Record<string, string> = {
      'example.com/a': a,
      'example.com/b': link,
      'example.com/c': '/nope/missing',
    };
    const out = await resolveReadRepos([remote('a', 'project'), remote('b'), remote('c'), remote('d')], {
      findRepo: async (n) => (paths[n] ? { localPath: paths[n] as string } : undefined),
      runnerRoot: '/runner-data',
      realHome: '/home/me',
    });
    expect(out.map((r) => [r.name, r.kind])).toEqual([['a', 'project']]);
    expect(out[0]?.path).toMatch(/aom-ref-/);
  });

  it('never opens the runner data dir, the home directory, a credential store or their parents', async () => {
    const find = (p: string) => async () => ({ localPath: p });
    const base = { runnerRoot: '/tmp', realHome: '/tmp' };
    for (const p of ['/', '/tmp']) {
      expect(await resolveReadRepos([remote('x')], { ...base, findRepo: find(p) }), p).toEqual([]);
    }
    const home = tmp('aom-home-');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    mkdirSync(join(home, 'src'), { recursive: true });
    const deps = { runnerRoot: join(home, '.aom-runner'), realHome: home };
    expect(await resolveReadRepos([remote('x')], { ...deps, findRepo: find(home) })).toEqual([]);
    expect(await resolveReadRepos([remote('x')], { ...deps, findRepo: find(join(home, '.ssh')) })).toEqual(
      [],
    );
    expect(
      await resolveReadRepos([remote('x')], { ...deps, findRepo: find(join(home, 'src')) }),
    ).toHaveLength(1);
  });
});

describe('instructions', () => {
  it('lists the readable folders and sends the agent to the project settings, not to a config key', () => {
    const text = renderReadableFolders(
      [
        { name: 'lib', path: '/src/lib', kind: 'reference' },
        { name: 'web', path: '/src/web', kind: 'project' },
      ],
      { workingDir: '/data/worktrees/x' },
    );
    expect(text).toContain('/src/lib (reference repository "lib", read-only)');
    expect(text).toContain('/src/web (repository of this project "web", read-only)');
    expect(text).toContain('Reference repositories');
    expect(text).toContain('do not look for a configuration key');
    expect(renderReadableFolders([])).toContain('No other repository is open for reading');
  });

  it('a chat names them; the DevOps engineer, who reads anywhere, gets no list', () => {
    const folders = [{ name: 'lib', path: '/src/lib', kind: 'reference' as const }];
    const base = { name: 'Ada', seniority: 'junior' as const };
    expect(renderChatInstructions({ ...base, roleKey: 'builder' }, {}, { readFolders: folders })).toContain(
      '/src/lib',
    );
    expect(
      renderChatInstructions({ ...base, roleKey: 'devops' }, {}, { readFolders: folders }),
    ).not.toContain('/src/lib');
    expect(renderChatInstructions({ ...base, roleKey: 'builder' }, {})).not.toContain('Folders you can read');
  });
});

describe('chat: project context', () => {
  const agent = {
    agentId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
    name: 'Ada',
    roleKey: 'builder',
    seniority: 'junior',
    runtime: 'mock',
    model: 'mock',
    skills: [],
    permissions: builder.permissions,
    isDevops: false,
  };
  const start = (context: Record<string, unknown>) => ({
    chatId: uuidv7(),
    threadId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
    agent,
    message: 'compare',
    context,
  });

  async function run(context: (repo: { remote: string }) => Record<string, unknown>, ref?: string) {
    h = await startHarness();
    if (ref) {
      const wt = join(h.dataDir, 'worktrees', 'TOY', ref);
      mkdirSync(wt, { recursive: true });
    }
    const adapter = h.runner.chat.deps.adapters.get('mock') as unknown as {
      startChat(i: ChatStartInput): Promise<unknown>;
    };
    const orig = adapter.startChat.bind(adapter);
    const seen: { input?: ChatStartInput } = {};
    adapter.startChat = async (input) => {
      seen.input = input;
      return orig(input);
    };
    const msg = start(context({ remote: h.repo.remoteNormalized }));
    h.server.send('chat.start', msg);
    await h.server.waitFor('chat.done', (d) => d.chatId === msg.chatId);
    return seen.input as ChatStartInput;
  }

  const readRepo = (remote: string, kind: 'project' | 'reference') => ({
    repoId: uuidv7(),
    name: 'toy',
    remoteUrlNormalized: remote,
    kind,
  });

  it('a chat about a project reads the project clone read-only, from the scratch dir', async () => {
    const input = await run((r) => ({
      projectKey: 'TOY',
      readRepos: [readRepo(r.remote, 'project'), readRepo('example.com/not-here', 'reference')],
    }));
    expect(input.cwd).toBe(input.sandbox.scratch);
    expect(input.readOnly).toBe(false);
    expect(input.readDirs).toHaveLength(1);
    expect(input.readDirs?.[0]).toMatch(/work[/\\]toy$/);
  });

  it('a card chat without its worktree here falls back to the project clone', async () => {
    const input = await run((r) => ({
      projectKey: 'TOY',
      cardRef: 'TOY-9',
      readRepos: [readRepo(r.remote, 'project')],
    }));
    expect(input.readOnly).toBe(false);
    expect(input.readDirs).toHaveLength(1);
  });

  it('a card chat with its worktree keeps reading it, and adds only the reference repositories', async () => {
    const input = await run(
      (r) => ({
        projectKey: 'TOY',
        cardRef: 'TOY-1',
        readRepos: [readRepo(r.remote, 'project')],
      }),
      'TOY-1',
    );
    expect(input.readOnly).toBe(true);
    expect(input.cwd).toMatch(/TOY[/\\]TOY-1$/);
    expect(input.readDirs).toEqual([]);
  });

  it('a card chat with its worktree also gets a reference repository', async () => {
    const input = await run(
      (r) => ({ projectKey: 'TOY', cardRef: 'TOY-1', readRepos: [readRepo(r.remote, 'reference')] }),
      'TOY-1',
    );
    expect(input.readOnly).toBe(true);
    expect(input.readDirs).toHaveLength(1);
  });

  it('a chat without context reads nothing besides its scratch dir', async () => {
    const input = await run(() => ({}));
    expect(input.readDirs).toEqual([]);
  });
});

describe('card shift: reference repositories', () => {
  type Spy = {
    start(i: { readDirs?: string[] }): Promise<unknown>;
    writeInstructions(s: unknown, md: string): Promise<void>;
  };
  const spy = (hh: Harness) => {
    const adapter = hh.runner.chat.deps.adapters.get('mock') as unknown as Spy;
    const seen: { readDirs?: string[]; instructions?: string } = {};
    const start = adapter.start.bind(adapter);
    const write = adapter.writeInstructions.bind(adapter);
    adapter.start = async (i) => {
      seen.readDirs = i.readDirs;
      return start(i);
    };
    adapter.writeInstructions = async (s, md) => {
      seen.instructions = md;
      return write(s, md);
    };
    return seen;
  };

  it('opens the project reference clones read-only and tells the agent which folders it can read', async () => {
    h = await startHarness();
    const seen = spy(h);
    const msg = {
      ...makeShiftStart({ remoteNormalized: h.repo.remoteNormalized }),
      readRepos: [
        { repoId: uuidv7(), name: 'toy', remoteUrlNormalized: h.repo.remoteNormalized, kind: 'reference' },
        { repoId: uuidv7(), name: 'absent', remoteUrlNormalized: 'example.com/absent', kind: 'reference' },
      ],
    };
    h.server.send('shift.start', msg);
    await h.server.waitFor(
      'shift.ended',
      (m) => m.shiftId === (msg as Record<string, unknown>).shiftId,
      60_000,
    );
    expect(seen.readDirs).toHaveLength(1);
    expect(seen.instructions).toContain('# Folders you can read');
    expect(seen.instructions).toContain('reference repository "toy", read-only');
    expect(seen.instructions).toContain('Project settings > Reference repositories');
    expect(seen.instructions).not.toContain('absent');
  });

  it('a shift without reference repositories still says what it can read', async () => {
    h = await startHarness();
    const seen = spy(h);
    await h.runShift({});
    expect(seen.readDirs).toEqual([]);
    expect(seen.instructions).toContain('No other repository is open for reading');
  });
});

describe('workstation repositories (any clone under a repoRoot)', () => {
  /** A repoRoot with a clone with a remote, one without a remote, and one in a sub folder. */
  function root() {
    const repo = makeRepo();
    const notes = join(repo.scanRoot, 'notes');
    mkdirSync(notes, { recursive: true });
    sh(notes, 'git', ['init', '-b', 'main']);
    writeFileSync(join(notes, 'ideas.md'), 'ideas\n');
    const deep = join(repo.scanRoot, 'clients', 'acme');
    mkdirSync(deep, { recursive: true });
    sh(deep, 'git', ['init', '-b', 'main']);
    return { repo, notes, deep };
  }

  it('scans repositories without a remote too, keyed by their path relative to the repoRoot', async () => {
    const { repo } = root();
    const all = await scanAllRepos([repo.scanRoot]);
    expect(all.map((r) => [r.localKey, r.remoteUrl === null])).toEqual([
      ['clients/acme', true],
      ['notes', true],
      ['toy', false],
    ]);
    // project matching still sees only what has a remote
    expect(withRemote(all).map((r) => r.localPath)).toEqual([repo.clone]);
    // excluded folders are not offered
    expect((await scanAllRepos([repo.scanRoot], (p) => p.endsWith('notes'))).map((r) => r.localKey)).toEqual([
      'clients/acme',
      'toy',
    ]);
  });

  it('reports the catalog in hello and repos.report without absolute paths, minus the data dir', async () => {
    const { repo } = root();
    // a repository inside the runner data dir is never offered
    const dataDir = tmp('aom-data-');
    const own = join(dataDir, 'inner');
    mkdirSync(own, { recursive: true });
    sh(own, 'git', ['init', '-b', 'main']);
    const server = await FakeServer.start();
    const config = makeConfig(server.url, { repoRoots: [repo.scanRoot, dataDir] });
    const runner = new Runner({ config, dataDir, exitGraceMs: 5000, rescanMs: 200 });
    await runner.start();
    try {
      await waitUntil(() => server.helloCount > 0, 10_000, 'hello');
      const hello = server.of('hello')[0];
      expect(hello?.repoCatalog).toEqual([
        { name: 'acme', localKey: 'clients/acme', remoteUrlNormalized: null },
        { name: 'notes', localKey: 'notes', remoteUrlNormalized: null },
        { name: 'toy', localKey: 'toy', remoteUrlNormalized: repo.remoteNormalized },
      ]);
      expect(JSON.stringify(hello?.repoCatalog)).not.toContain(repo.scanRoot);
      await waitUntil(() => server.of('repos.report').length > 0, 10_000, 'repos.report');
      expect(server.of('repos.report')[0]?.repoCatalog).toHaveLength(3);
    } finally {
      await runner.stop();
      await server.close();
    }
  });

  it('opens a clone picked on this workstation by key, a clone with a remote by remote, once each', async () => {
    const { repo, notes } = root();
    const deps = {
      findRepo: async (n: string) => (n === repo.remoteNormalized ? { localPath: repo.clone } : undefined),
      findLocal: async (k: string) =>
        ({ notes: { localPath: notes }, toy: { localPath: repo.clone } })[k as 'notes'],
      runnerRoot: '/runner-data',
      realHome: '/home/me',
    };
    const out = await resolveReadRepos(undefined, deps, [
      { name: 'notes', localKey: 'notes' }, // no remote: by key, on its workstation
      { name: 'toy', remoteUrlNormalized: repo.remoteNormalized }, // another workstation: by remote
      { name: 'toy again', localKey: 'toy', remoteUrlNormalized: repo.remoteNormalized }, // same clone: once
      { name: 'gone', localKey: 'missing' },
      { name: 'elsewhere', remoteUrlNormalized: 'example.com/elsewhere' },
    ]);
    expect(out.map((r) => [r.name, r.kind])).toEqual([
      ['notes', 'reference'],
      ['toy', 'reference'],
    ]);
  });

  it('a key never opens a folder that holds credentials or the runner state', async () => {
    const home = tmp('aom-home-');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    const out = await resolveReadRepos(
      undefined,
      {
        findRepo: async () => undefined,
        findLocal: async () => ({ localPath: join(home, '.ssh') }),
        runnerRoot: join(home, '.aom-runner'),
        realHome: home,
      },
      [{ name: 'ssh', localKey: '.ssh' }],
    );
    expect(out).toEqual([]);
  });

  it('a card shift opens a clone without a remote named by key', async () => {
    const { repo, notes } = root();
    h = await startHarness({}, {}, repo);
    const adapter = h.runner.chat.deps.adapters.get('mock') as unknown as {
      start(i: { readDirs?: string[] }): Promise<unknown>;
    };
    const seen: string[] = [];
    const start = adapter.start.bind(adapter);
    adapter.start = async (i) => {
      seen.push(...(i.readDirs ?? []));
      return start(i);
    };
    const msg = {
      ...makeShiftStart({ remoteNormalized: repo.remoteNormalized }),
      localReadRepos: [{ name: 'notes', localKey: 'notes' }],
    };
    h.server.send('shift.start', msg);
    await h.server.waitFor(
      'shift.ended',
      (m) => m.shiftId === (msg as Record<string, unknown>).shiftId,
      60_000,
    );
    expect(seen.map((p) => realpathSync(p))).toEqual([realpathSync(notes)]);
  });
});
