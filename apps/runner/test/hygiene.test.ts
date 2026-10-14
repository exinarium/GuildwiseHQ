import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { HygieneRepoSpec, IpcRpcRequest, ShiftReport } from '@aom/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type AomContext, runAom } from '../src/aom/aom-cli.ts';
import { hygieneRepo, runHygiene } from '../src/devops/hygiene.ts';
import { IpcServer } from '../src/ipc/server.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

cleanupTmp();

const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const saved: Record<string, string | undefined> = {};
const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
  GIT_CONFIG_NOSYSTEM: '1',
};
beforeAll(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const spec = (repo: TestRepo, over: Partial<HygieneRepoSpec> = {}): HygieneRepoSpec => ({
  repoId: U,
  projectId: U,
  projectKey: 'TOY',
  projectName: 'Toy',
  name: 'toy',
  localPath: repo.clone,
  remoteUrl: repo.origin,
  workingBranch: 'main',
  branchSource: 'repo',
  branchPrefix: 'aom/',
  finishedBranches: [],
  mainBranch: null,
  finishedCards: [],
  ...over,
});

const originHead = (repo: TestRepo, branch = 'main') => sh(repo.origin, 'git', ['rev-parse', branch]);
const write = (repo: TestRepo, file: string, text: string) => writeFileSync(join(repo.clone, file), text);

/** Another clone of the origin pushes a commit (somebody else's work). */
function remoteCommit(repo: TestRepo, file: string, text: string, branch = 'main') {
  const other = join(tmp(), 'other');
  sh(repo.root, 'git', ['clone', repo.origin, other]);
  sh(other, 'git', ['checkout', branch]);
  writeFileSync(join(other, file), text);
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', `remote ${file}`]);
  sh(other, 'git', ['push', 'origin', branch]);
}

describe('repository hygiene: the working branch must be confirmed', () => {
  it('commits nothing and pushes nothing while the working branch is unset; it reports the changes and the branches', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['branch', 'develop']);
    sh(repo.clone, 'git', ['push', 'origin', 'develop']);
    const before = originHead(repo);
    const localBefore = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
    write(repo, 'wip.txt', 'unsaved');
    write(repo, 'README.md', '# changed\n');

    const { result, commands } = await hygieneRepo(spec(repo, { workingBranch: null, branchSource: null }));

    expect(result.problem?.kind).toBe('needs_branch');
    expect(result.uncommitted.sort()).toEqual(['README.md', 'wip.txt']);
    expect(result.branches).toEqual(['develop', 'main']);
    expect(result.commit).toBeUndefined();
    expect(result.pushed).toBe(false);
    expect(sh(repo.clone, 'git', ['rev-parse', 'HEAD'])).toBe(localBefore); // not committed
    expect(originHead(repo)).toBe(before); // not pushed
    expect(sh(repo.clone, 'git', ['status', '--porcelain'])).toContain('wip.txt'); // still there
    // only a fetch ran; no commit, pull or push
    expect(commands.filter((c) => /commit|pull|push|add/.test(c))).toEqual([]);
  });

  it('agent branches are not offered as the working branch', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['branch', 'aom/toy-1-x']);
    const { result } = await hygieneRepo(spec(repo, { workingBranch: null, branchSource: null }));
    expect(result.branches).toEqual(['main']);
  });
});

describe('repository hygiene: commit, pull and push on the working branch', () => {
  it('stores uncommitted changes in a stash, never pushed, no branch; main and the checkout are untouched', async () => {
    const repo = makeRepo();
    const mainBefore = originHead(repo);
    const branchesBefore = sh(repo.origin, 'git', ['branch', '--list']);
    write(repo, 'wip.txt', 'unsaved');
    write(repo, 'README.md', '# changed\n');
    const statusBefore = sh(repo.clone, 'git', ['status', '--porcelain']);
    const { result, commands } = await hygieneRepo(spec(repo));
    expect(result.problem).toBeNull();
    const saved = result.savedWork;
    expect(saved?.branch).toBe('');
    expect(saved?.stash).toMatch(/^saved work \d{4}-\d{2}-\d{2}T[\d:.]+Z: 2 file\(s\) not committed$/);
    expect(saved?.files.sort()).toEqual(['README.md', 'wip.txt']);
    expect(saved?.pushed).toBe(false);
    expect(result.actions.join(' ')).toContain('stored 2 unsaved file(s) in a stash');
    // nothing landed on main, nothing was pushed, no branch of any name was made
    expect(originHead(repo)).toBe(mainBefore);
    expect(sh(repo.clone, 'git', ['rev-parse', 'main'])).toBe(mainBefore);
    expect(sh(repo.origin, 'git', ['branch', '--list'])).toBe(branchesBefore);
    expect(sh(repo.clone, 'git', ['branch', '--list'])).not.toMatch(/guildwise|saved/);
    expect(commands.some((c) => /\bpush\b/.test(c))).toBe(false);
    // the user's files, index and status are exactly as they were
    expect(readFileSync(join(repo.clone, 'wip.txt'), 'utf8')).toBe('unsaved');
    expect(sh(repo.clone, 'git', ['status', '--porcelain'])).toBe(statusBefore);
    // a real stash entry: list shows it, and applying it in a clean clone brings back tracked and untracked edits
    expect(sh(repo.clone, 'git', ['stash', 'list'])).toContain(saved?.stash as string);
    const clone2 = join(tmp(), 'clone2');
    sh(repo.root, 'git', ['clone', repo.origin, clone2]);
    sh(clone2, 'git', ['fetch', repo.clone, 'refs/stash:refs/stash']);
    sh(clone2, 'git', ['stash', 'apply', 'refs/stash']);
    expect(readFileSync(join(clone2, 'wip.txt'), 'utf8')).toBe('unsaved');
    expect(readFileSync(join(clone2, 'README.md'), 'utf8')).toBe('# changed\n');
  });

  it('skips files that look like secrets and tells which', async () => {
    const repo = makeRepo();
    write(repo, 'wip.txt', 'unsaved');
    write(repo, '.env', 'TOKEN=abc');
    write(repo, 'deploy.pem', 'pem');
    write(repo, 'api-key.json', '{}');
    write(repo, 'keyboard.ts', 'export {}');
    const { result } = await hygieneRepo(spec(repo));
    const saved = result.savedWork;
    expect(saved?.files.sort()).toEqual(['keyboard.ts', 'wip.txt']);
    expect(saved?.skipped.sort()).toEqual(['.env', 'api-key.json', 'deploy.pem']);
    const tree = sh(repo.clone, 'git', ['stash', 'show', '--include-untracked', '--name-only', 'stash@{0}']);
    expect(tree).toContain('wip.txt');
    expect(tree).not.toContain('.env');
    expect(tree).not.toContain('deploy.pem');
    // the secrets stay where they were
    expect(readFileSync(join(repo.clone, '.env'), 'utf8')).toBe('TOKEN=abc');
  });

  it('does not save the same edits twice', async () => {
    const repo = makeRepo();
    write(repo, 'wip.txt', 'unsaved');
    const first = await hygieneRepo(spec(repo));
    const second = await hygieneRepo(spec(repo));
    expect(second.result.savedWork?.stash).toBe(first.result.savedWork?.stash);
    expect(sh(repo.clone, 'git', ['stash', 'list']).split('\n')).toHaveLength(1);
  });

  it('only secret-looking edits: nothing is saved, the files are named', async () => {
    const repo = makeRepo();
    write(repo, '.env.local', 'X=1');
    const { result } = await hygieneRepo(spec(repo));
    expect(result.savedWork).toMatchObject({ branch: '', files: [], skipped: ['.env.local'] });
    expect(sh(repo.clone, 'git', ['stash', 'list'])).toBe('');
  });

  it('pushes commits that were not pushed', async () => {
    const repo = makeRepo();
    write(repo, 'a.txt', 'a');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'local work']);
    const { result } = await hygieneRepo(spec(repo));
    expect(result.problem).toBeNull();
    expect(result.pushed).toBe(true);
    expect(originHead(repo)).toBe(sh(repo.clone, 'git', ['rev-parse', 'HEAD']));
  });

  it('pulls what the remote has and does nothing when everything is in order', async () => {
    const repo = makeRepo();
    remoteCommit(repo, 'theirs.txt', 'x');
    const first = await hygieneRepo(spec(repo));
    expect(first.result.problem).toBeNull();
    expect(first.result.actions.join(' ')).toContain('pulled main');
    expect(readFileSync(join(repo.clone, 'theirs.txt'), 'utf8')).toBe('x');
    const second = await hygieneRepo(spec(repo));
    expect(second.result).toMatchObject({ problem: null, pushed: false });
    expect(second.result.actions).toContain('main is in order');
  });

  it('pulls what the remote has while the unsaved edits stay in the checkout', async () => {
    const repo = makeRepo();
    remoteCommit(repo, 'theirs.txt', 'x');
    write(repo, 'mine.txt', 'unsaved');
    const { result } = await hygieneRepo(spec(repo));
    expect(result.problem).toBeNull();
    expect(readFileSync(join(repo.clone, 'theirs.txt'), 'utf8')).toBe('x');
    expect(readFileSync(join(repo.clone, 'mine.txt'), 'utf8')).toBe('unsaved');
    expect(result.savedWork?.stash).toBeTruthy();
    expect(sh(repo.origin, 'git', ['ls-tree', '-r', '--name-only', 'main'])).not.toContain('mine.txt');
  });

  it('edits that overlap the remote are saved and the update waits: no conflict, nothing lost, nothing pushed to main', async () => {
    const repo = makeRepo();
    remoteCommit(repo, 'README.md', '# theirs\n');
    const before = originHead(repo);
    write(repo, 'README.md', '# mine\n');
    const { result } = await hygieneRepo(spec(repo));
    expect(result.problem).toBeNull();
    expect(result.actions.join(' ')).toContain('not updated yet');
    expect(originHead(repo)).toBe(before);
    expect(readFileSync(join(repo.clone, 'README.md'), 'utf8')).toBe('# mine\n');
    expect(sh(repo.clone, 'git', ['show', 'stash@{0}:README.md'])).toBe('# mine');
  });
});

describe('repository hygiene: a checkout on another branch', () => {
  it('stores uncommitted changes of another branch in a stash built on that branch and leaves the checkout alone', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['checkout', '-b', 'feature/x']);
    write(repo, 'wip.txt', 'unsaved');
    const head = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
    const { result } = await hygieneRepo(spec(repo));
    expect(result.problem).toBeNull();
    expect(result.savedWork?.files).toEqual(['wip.txt']);
    expect(sh(repo.clone, 'git', ['rev-parse', 'stash@{0}^1'])).toBe(head);
    expect(sh(repo.clone, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(repo.clone, 'git', ['branch', '--show-current'])).toBe('feature/x');
    expect(sh(repo.clone, 'git', ['status', '--porcelain'])).toContain('wip.txt');
  });

  it('a clean checkout on another branch still gets the working branch moved forward and pushed', async () => {
    const repo = makeRepo();
    remoteCommit(repo, 'theirs.txt', 'x');
    sh(repo.clone, 'git', ['checkout', '-b', 'feature/x']);
    const behind = await hygieneRepo(spec(repo));
    expect(behind.result.problem).toBeNull();
    expect(sh(repo.clone, 'git', ['rev-parse', 'main'])).toBe(originHead(repo));
    // local commits on main (checked out nowhere) are pushed
    sh(repo.clone, 'git', ['checkout', 'main']);
    write(repo, 'a.txt', 'a');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'local']);
    sh(repo.clone, 'git', ['checkout', 'feature/x']);
    const ahead = await hygieneRepo(spec(repo));
    expect(ahead.result).toMatchObject({ problem: null, pushed: true });
    expect(originHead(repo)).toBe(sh(repo.clone, 'git', ['rev-parse', 'main']));
  });

  it('reports a working branch that does not exist', async () => {
    const repo = makeRepo();
    write(repo, 'wip.txt', 'unsaved');
    const { result } = await hygieneRepo(spec(repo, { workingBranch: 'nope' }));
    expect(result.problem?.kind).toBe('branch_missing');
    expect(result.uncommitted).toEqual(['wip.txt']);
  });

  it('reports a clone that is not there', async () => {
    const repo = makeRepo();
    const { result } = await hygieneRepo(spec(repo, { localPath: join(repo.root, 'gone') }));
    expect(result.problem?.kind).toBe('missing');
  });
});

describe('repository hygiene: authentication', () => {
  it('a remote that refuses the credentials is an auth failure; the local commit is kept', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const repo = makeRepo();
      sh(repo.clone, 'git', [
        'remote',
        'set-url',
        'origin',
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/acme/toy.git`,
      ]);
      write(repo, 'wip.txt', 'unsaved');
      const { result } = await hygieneRepo(spec(repo));
      expect(result.problem?.kind).toBe('auth_failed');
      expect(result.pushed).toBe(false);
    } finally {
      server.close();
    }
  });
});

describe('repository hygiene: branches of finished cards', () => {
  it('deletes merged agent branches, keeps unmerged ones, other prefixes and ones checked out in a worktree', async () => {
    const repo = makeRepo();
    for (const b of ['aom/merged', 'aom/unmerged', 'aom/in-use', 'feature/merged']) {
      sh(repo.clone, 'git', ['branch', b]);
    }
    sh(repo.clone, 'git', ['checkout', 'aom/unmerged']);
    write(repo, 'u.txt', 'u');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'unmerged work']);
    sh(repo.clone, 'git', ['checkout', 'main']);
    const wt = join(tmp(), 'wt');
    mkdirSync(wt, { recursive: true });
    sh(repo.clone, 'git', ['worktree', 'add', join(wt, 'in-use'), 'aom/in-use']);
    const { result } = await hygieneRepo(
      spec(repo, {
        finishedBranches: ['aom/merged', 'aom/unmerged', 'aom/in-use', 'feature/merged', 'aom/gone'],
      }),
    );
    expect(result.removedBranches).toEqual(['aom/merged']);
    const branches = sh(repo.clone, 'git', ['branch', '--format=%(refname:short)']).split('\n');
    expect(branches).toEqual(expect.arrayContaining(['aom/unmerged', 'aom/in-use', 'feature/merged']));
    expect(branches).not.toContain('aom/merged');
  });
});

describe('aom hygiene run', () => {
  const servers: IpcServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  async function cli(hygiene: unknown) {
    const reports: ShiftReport[] = [];
    const rpcs: IpcRpcRequest[] = [];
    const ipc = new IpcServer();
    servers.push(ipc);
    await ipc.start();
    const token = ipc.registerShift({
      report: async (r) => {
        reports.push(r.report);
        return { accepted: true, message: 'Recorded.' } as never;
      },
      rpc: async (r) => {
        rpcs.push(r);
        return { ok: true, result: { devops: { hygiene } } };
      },
    });
    const out: string[] = [];
    const ctx: AomContext = {
      env: { AOM_IPC_URL: ipc.url, AOM_SHIFT_TOKEN: token },
      io: { out: (s) => out.push(s), err: (s) => out.push(s) },
      fetch,
      readFile: () => '',
    };
    return { run: (...a: string[]) => runAom(a, ctx), reports, out };
  }

  it('does the work and ends the request with devops_done carrying the structured report', async () => {
    const good = makeRepo();
    write(good, 'wip.txt', 'unsaved');
    const unset = makeRepo();
    write(unset, 'other.txt', 'unsaved');
    const repoB = '019e3f6a-7b1c-7a2d-8c3e-0123456789b2';
    const t = await cli({
      trigger: 'manual',
      repos: [
        spec(good),
        spec(unset, { repoId: repoB, name: 'notes', workingBranch: null, branchSource: null }),
      ],
    });
    expect(await t.run('hygiene', 'run')).toBe(0);
    expect(t.reports).toHaveLength(1);
    const rep = t.reports[0] as Extract<ShiftReport, { kind: 'outcome' }>;
    expect(rep.outcomeId).toBe('devops_done');
    const data = rep.data as {
      summary: string;
      commands: string[];
      hygiene: { repos: Array<{ repoId: string; problem: { kind: string } | null; commit?: string }> };
    };
    expect(data.summary).toContain('1 need attention');
    expect(data.commands.some((c) => c.includes('stash store'))).toBe(true);
    expect(data.hygiene.repos[0]?.problem).toBeNull();
    expect((data.hygiene.repos[0] as { savedWork?: unknown }).savedWork).toBeDefined();
    expect(data.hygiene.repos[1]?.problem?.kind).toBe('needs_branch');
    expect(sh(unset.clone, 'git', ['status', '--porcelain'])).toContain('other.txt');
  });

  it('refuses a request that is not a hygiene request', async () => {
    const t = await cli(undefined);
    expect(await t.run('hygiene', 'run')).toBe(1);
    expect(t.reports).toHaveLength(0);
  });
});

/** Local commit, pushed: the old remote tip. */
function pushedCommit(repo: TestRepo, file: string, text: string) {
  write(repo, file, text);
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', `local ${file}`]);
  sh(repo.clone, 'git', ['push', 'origin', 'main']);
}

/** Somebody force-pushes main: the last `drop` commits are removed and one new commit is added. */
function forceRewrite(repo: TestRepo, drop: number, file = 'fixed.txt') {
  const other = join(tmp(), 'rewriter');
  sh(repo.root, 'git', ['clone', repo.origin, other]);
  sh(other, 'git', ['checkout', 'main']);
  sh(other, 'git', ['reset', '--hard', `HEAD~${drop}`]);
  writeFileSync(join(other, file), 'repaired');
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', `repair ${file}`]);
  sh(other, 'git', ['push', '--force', 'origin', 'main']);
}

describe('repository hygiene: a rewritten (force-pushed) working branch is followed, never merged back', () => {
  it('checked out with an uncommitted change: realigned with reset --keep, change preserved, nothing pushed, no conflict', async () => {
    const repo = makeRepo();
    pushedCommit(repo, 'stale1.txt', 'a');
    pushedCommit(repo, 'stale2.txt', 'b');
    forceRewrite(repo, 2);
    const rewritten = originHead(repo);
    write(repo, 'README.md', '# my edit\n');

    const { result, commands } = await hygieneRepo(spec(repo));

    expect(result.problem).toBeNull();
    expect(result.rewritten?.realigned).toBe(true);
    expect(result.rewritten?.commits).toEqual([]);
    expect(sh(repo.clone, 'git', ['rev-parse', 'HEAD'])).toBe(rewritten);
    expect(sh(repo.clone, 'git', ['branch', '--show-current'])).toBe('main');
    expect(existsSync(join(repo.clone, 'stale1.txt'))).toBe(false);
    expect(readFileSync(join(repo.clone, 'README.md'), 'utf8')).toBe('# my edit\n');
    expect(originHead(repo)).toBe(rewritten);
    expect(result.pushed).toBe(false);
    expect(commands.join('\n')).not.toMatch(/push (-u )?origin main/);
    expect(sh(repo.clone, 'git', ['branch', '--list', 'conflict/*'])).toBe('');
  });

  it('not checked out: the branch is moved to the new remote, nothing pushed', async () => {
    const repo = makeRepo();
    pushedCommit(repo, 'stale1.txt', 'a');
    forceRewrite(repo, 1);
    const rewritten = originHead(repo);
    sh(repo.clone, 'git', ['checkout', '-b', 'feature/x']);

    const { result } = await hygieneRepo(spec(repo));

    expect(result.problem).toBeNull();
    expect(result.rewritten?.realigned).toBe(true);
    expect(sh(repo.clone, 'git', ['rev-parse', 'main'])).toBe(rewritten);
    expect(originHead(repo)).toBe(rewritten);
    expect(result.pushed).toBe(false);
  });

  it('local commits that were never on the remote are kept in a stash (no branch), the branch is realigned, nothing pushed', async () => {
    const repo = makeRepo();
    pushedCommit(repo, 'stale1.txt', 'a');
    write(repo, 'mine.txt', 'new work');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'my unpushed work']);
    const localTip = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
    forceRewrite(repo, 1);
    const rewritten = originHead(repo);
    const branchesBefore = sh(repo.origin, 'git', ['branch', '--list']);

    const { result } = await hygieneRepo(spec(repo));

    expect(result.problem).toBeNull();
    expect(result.rewritten?.commits).toHaveLength(1);
    expect(result.rewritten?.commits[0]).toContain('my unpushed work');
    expect(result.rewritten?.savedStash).toMatch(/^saved work .*1 local commit\(s\) of main/);
    expect(result.rewritten?.savedBranch).toBeUndefined();
    expect(sh(repo.clone, 'git', ['rev-parse', 'main'])).toBe(rewritten);
    expect(originHead(repo)).toBe(rewritten);
    expect(sh(repo.origin, 'git', ['branch', '--list'])).toBe(branchesBefore);
    expect(sh(repo.clone, 'git', ['branch', '--list'])).not.toMatch(/saved|guildwise/);
    // the commits are recoverable from the stash without any ref name
    expect(sh(repo.clone, 'git', ['rev-parse', 'stash@{0}^1'])).toBe(localTip);
    sh(repo.clone, 'git', ['branch', 'recovered', 'stash@{0}^1']);
    expect(sh(repo.clone, 'git', ['log', '-1', '--format=%s', 'recovered'])).toBe('my unpushed work');
  });

  it('normal divergence (both sides have new work) is still a conflict, and nothing is pushed', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['checkout', '-b', 'feature/x']);
    sh(repo.clone, 'git', ['checkout', 'main']);
    write(repo, 'local.txt', 'l');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'local only']);
    remoteCommit(repo, 'theirs.txt', 't');
    const before = originHead(repo);
    sh(repo.clone, 'git', ['checkout', 'feature/x']);

    const { result, commands } = await hygieneRepo(spec(repo));

    expect(result.problem?.kind).toBe('conflict');
    expect(result.rewritten).toBeUndefined();
    expect(originHead(repo)).toBe(before);
    expect(commands.join('\n')).not.toMatch(/push (-u )?origin main/);
  });
});

describe('repository hygiene: defers while a card shift runs in the repository', () => {
  it('changes nothing (no stash, no pull) when a linked worktree has a running shift', async () => {
    const repo = makeRepo();
    const wt = join(tmp(), 'card-wt');
    sh(repo.clone, 'git', ['worktree', 'add', '-b', 'aom/toy-1-x', wt]);
    remoteCommit(repo, 'theirs.txt', 't');
    write(repo, 'wip.txt', 'unsaved');
    const head = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);

    const { result } = await hygieneRepo(spec(repo), [wt]);

    expect(result.problem).toBeNull();
    expect(result.actions.join(' ')).toContain('deferred');
    expect(result.savedWork).toBeUndefined();
    expect(sh(repo.clone, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(sh(repo.clone, 'git', ['stash', 'list'])).toBe('');

    const later = await hygieneRepo(spec(repo), []);
    expect(later.result.savedWork?.stash).toBeTruthy();
  });
});

describe('repository hygiene: old saved-work branches are migrated away', () => {
  it('stores local and origin guildwise/saved-work branches in stashes and deletes them', async () => {
    const repo = makeRepo();
    // an old-style branch with one commit, local and on origin
    sh(repo.clone, 'git', ['checkout', '-b', 'guildwise/saved-work/2026-10-01']);
    write(repo, 'old.txt', 'old');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'saved work (old)']);
    const oldTip = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
    sh(repo.clone, 'git', ['push', 'origin', 'guildwise/saved-work/2026-10-01']);
    sh(repo.clone, 'git', ['checkout', 'main']);
    // one that exists on origin only
    sh(repo.clone, 'git', ['checkout', '-b', 'guildwise/saved-work/2026-10-02', 'main']);
    write(repo, 'old2.txt', 'old2');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'saved work (old 2)']);
    const old2Tip = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
    sh(repo.clone, 'git', ['push', 'origin', 'guildwise/saved-work/2026-10-02']);
    sh(repo.clone, 'git', ['checkout', 'main']);
    sh(repo.clone, 'git', ['branch', '-D', 'guildwise/saved-work/2026-10-02']);
    sh(repo.clone, 'git', ['branch', 'keepme', 'main']);
    sh(repo.clone, 'git', ['push', 'origin', 'keepme']);

    const { result } = await hygieneRepo(spec(repo));

    expect(result.problem).toBeNull();
    expect(sh(repo.clone, 'git', ['branch', '-a', '--list', '*saved-work*'])).toBe('');
    expect(sh(repo.origin, 'git', ['branch', '--list'])).not.toContain('saved-work');
    expect(sh(repo.origin, 'git', ['branch', '--list'])).toContain('keepme');
    const parents = sh(repo.clone, 'git', ['stash', 'list', '--format=%H'])
      .split('\n')
      .map((h) => sh(repo.clone, 'git', ['rev-parse', `${h}^1`]));
    expect(parents).toEqual(expect.arrayContaining([oldTip, old2Tip]));
    expect(result.actions.join('\n')).toContain('removed that branch from origin');
  });
});

describe('runHygiene', () => {
  it('summarizes every repository', async () => {
    const repo = makeRepo();
    const run = await runHygiene({ trigger: 'schedule', repos: [spec(repo)] });
    expect(run.summary).toContain('1 repository checked, all in order');
    expect(run.summary).toContain('TOY toy');
  });
});
