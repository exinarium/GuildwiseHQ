import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeSpec } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { computeDiffStats, riskTier } from '../src/git/diffstat.ts';
import { scanRepos } from '../src/git/repo-scan.ts';
import {
  BaseBranchMissingError,
  ensureWorktree,
  RebaseConflictError,
  rebaseOntoBase,
  removeWorktree,
  WorktreeError,
} from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const spec = (o: Partial<WorktreeSpec> = {}): WorktreeSpec => ({
  mode: 'create',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: 'x',
  baseBranch: 'main',
  branchName: 'aom/toy-1-add-greeting',
  ...o,
});

describe('worktrees', () => {
  it('creates aom/<ref>-<slug> from origin/<base>, then reuses it', async () => {
    const repo = makeRepo();
    // Advance origin so origin/main is ahead of the clone's local main.
    const other = join(tmp(), 'other');
    sh(repo.root, 'git', ['clone', repo.origin, other]);
    writeFileSync(join(other, 'new.txt'), 'x');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', 'ahead']);
    sh(other, 'git', ['push', 'origin', 'main']);

    const path = join(tmp(), 'wt', 'TOY-1');
    const created = await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: spec(),
      defaultPath: path,
    });
    expect(created).toMatchObject({
      path,
      branchName: 'aom/toy-1-add-greeting',
      baseBranch: 'main',
      created: true,
    });
    expect(existsSync(join(path, 'new.txt'))).toBe(true); // branched from the fetched origin/main
    expect(sh(path, 'git', ['branch', '--show-current'])).toBe('aom/toy-1-add-greeting');

    writeFileSync(join(path, 'work.txt'), 'w');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'work']);
    const reused = await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: spec({ mode: 'reuse', path }),
      defaultPath: path,
    });
    expect(reused.created).toBe(false);
    expect(reused.headSha).toBe(sh(path, 'git', ['rev-parse', 'HEAD']));
  });

  it('create is idempotent (retry after a rejected first shift)', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec: spec(), defaultPath: path });
    const again = await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: spec(),
      defaultPath: path,
    });
    expect(again.created).toBe(false);
  });

  it('recreates the worktree from the branch when the directory vanished', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec: spec(), defaultPath: path });
    writeFileSync(join(path, 'kept.txt'), 'k');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'kept']);
    rmSync(path, { recursive: true, force: true });
    const r = await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: spec({ mode: 'reuse' }),
      defaultPath: path,
    });
    expect(existsSync(join(r.path, 'kept.txt'))).toBe(true);
    expect(sh(path, 'git', ['branch', '--show-current'])).toBe('aom/toy-1-add-greeting');
  });

  it('rejects with worktree_failed (WorktreeError) when reuse finds neither directory nor branch', async () => {
    const repo = makeRepo();
    await expect(
      ensureWorktree({
        repoPath: repo.clone,
        roots: ['/'],
        spec: spec({ mode: 'reuse', branchName: 'aom/gone' }),
        defaultPath: join(tmp(), 'wt'),
      }),
    ).rejects.toBeInstanceOf(WorktreeError);
  });

  it('fails when the base branch does not exist', async () => {
    const repo = makeRepo();
    await expect(
      ensureWorktree({
        repoPath: repo.clone,
        roots: ['/'],
        spec: spec({ baseBranch: 'nope' }),
        defaultPath: join(tmp(), 'wt'),
      }),
    ).rejects.toBeInstanceOf(WorktreeError);
  });

  it('works for a repo without an origin (base = local branch)', async () => {
    const root = tmp();
    sh(root, 'git', ['init', '-b', 'main', 'solo']);
    const solo = join(root, 'solo');
    writeFileSync(join(solo, 'a.txt'), 'a');
    sh(solo, 'git', ['add', '-A']);
    sh(solo, 'git', ['commit', '-m', 'init']);
    const r = await ensureWorktree({
      repoPath: solo,
      roots: ['/'],
      spec: spec(),
      defaultPath: join(root, 'wt'),
    });
    expect(r.created).toBe(true);
  });

  it('worktree.remove is idempotent and can delete the branch', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec: spec(), defaultPath: path });
    const first = await removeWorktree({
      path,
      branchName: 'aom/toy-1-add-greeting',
      deleteBranch: true,
      roots: ['/'],
    });
    expect(first).toEqual({ removed: true, branchDeleted: true });
    expect(existsSync(path)).toBe(false);
    expect(sh(repo.clone, 'git', ['branch', '--list', 'aom/*'])).toBe('');
    expect(await removeWorktree({ path, roots: ['/'] })).toEqual({ removed: false, branchDeleted: false });
  });

  it('rebase conflict is aborted and reports the conflicted files', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec: spec(), defaultPath: path });
    writeFileSync(join(path, 'README.md'), 'branch change\n');
    sh(path, 'git', ['commit', '-am', 'branch']);
    writeFileSync(join(repo.clone, 'README.md'), 'main change\n');
    sh(repo.clone, 'git', ['commit', '-am', 'main']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const err = await rebaseOntoBase(path, 'main').catch((e) => e);
    expect(err).toBeInstanceOf(RebaseConflictError);
    expect((err as RebaseConflictError).conflictedFiles).toEqual(['README.md']);
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
    expect(sh(path, 'git', ['branch', '--show-current'])).toBe('aom/toy-1-add-greeting');
  });
});

describe('a working branch the clone does not have', () => {
  const masterOnly = () => {
    const root = tmp();
    const origin = join(root, 'origin.git');
    const clone = join(root, 'barcode');
    sh(root, 'git', ['init', '--bare', '-b', 'master', origin]);
    sh(root, 'git', ['clone', origin, clone]);
    sh(clone, 'git', ['checkout', '-b', 'master']);
    writeFileSync(join(clone, 'README.md'), '# barcode\n');
    sh(clone, 'git', ['add', '-A']);
    sh(clone, 'git', ['commit', '-m', 'initial']);
    sh(clone, 'git', ['push', '-u', 'origin', 'master']);
    sh(clone, 'git', ['remote', 'set-head', 'origin', 'master']);
    return clone;
  };

  it("says which branch is missing and what the repository's default branch is", async () => {
    const clone = masterOnly();
    const err = await ensureWorktree({
      repoPath: clone,
      roots: ['/'],
      spec: spec({ baseBranch: 'main' }),
      defaultPath: join(tmp(), 'wt', 'BC-1'),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BaseBranchMissingError);
    expect(err).toBeInstanceOf(WorktreeError);
    expect(err.message).toBe(
      "working branch 'main' does not exist in this repo; its default branch is 'master'",
    );
    expect(err).toMatchObject({ base: 'main', defaultBranch: 'master', branches: ['master'] });
  });

  it('takes the only branch for the default when origin/HEAD is not set, and none when it cannot tell', async () => {
    const clone = masterOnly();
    sh(clone, 'git', ['remote', 'set-head', 'origin', '--delete']);
    const miss = (base: string) =>
      ensureWorktree({
        repoPath: clone,
        roots: ['/'],
        spec: spec({ baseBranch: base }),
        defaultPath: join(tmp(), 'wt', 'BC-2'),
      }).catch((e) => e);
    expect((await miss('main')).defaultBranch).toBe('master');
    sh(clone, 'git', ['branch', 'develop']);
    const two = await miss('main');
    expect(two.defaultBranch).toBeNull();
    expect(two.message).toBe("working branch 'main' does not exist in this repo");
    expect(two.branches).toEqual(['develop', 'master']);
  });
});

describe('repo scan', () => {
  it('finds repos to depth 3 with origin and head branch, skipping node_modules and repos without origin', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo.scanRoot, 'a', 'b'), { recursive: true });
    sh(join(repo.scanRoot, 'a', 'b'), 'git', ['init', '-b', 'main', 'noremote']);
    mkdirSync(join(repo.scanRoot, 'node_modules', 'x'), { recursive: true });
    sh(join(repo.scanRoot, 'node_modules'), 'git', ['clone', repo.origin, 'x/inner']);
    const found = await scanRepos([repo.scanRoot, '/definitely/not/there']);
    expect(found).toEqual([{ remoteUrl: repo.origin, localPath: repo.clone, headBranch: 'main' }]);
  });
});

describe('diffstat and risk tier', () => {
  const setup = async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec: spec(), defaultPath: path });
    return path;
  };

  it('counts files and lines against the merge base', async () => {
    const path = await setup();
    writeFileSync(join(path, 'a.ts'), 'a\nb\nc\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'a']);
    const stats = await computeDiffStats({ worktree: path, baseBranch: 'main', architecturalGlobs: [] });
    expect(stats).toEqual({ files: 1, added: 3, removed: 0, architecturalPaths: [], testFiles: 0 });
    expect(riskTier(stats, 'feature')).toBe('small');
    expect(riskTier(stats, 'refactor')).toBe('large');
  });

  it('is large at 200 changed lines or when an architectural path matches', async () => {
    const path = await setup();
    writeFileSync(join(path, 'big.ts'), `${'x\n'.repeat(200)}`);
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'big']);
    expect(
      riskTier(
        await computeDiffStats({ worktree: path, baseBranch: 'main', architecturalGlobs: [] }),
        'feature',
      ),
    ).toBe('large');

    const path2 = await setup();
    mkdirSync(join(path2, 'apps/web/src'), { recursive: true });
    writeFileSync(join(path2, 'apps/web/src/router.tsx'), 'r\n');
    sh(path2, 'git', ['add', '-A']);
    sh(path2, 'git', ['commit', '-m', 'router']);
    const stats = await computeDiffStats({
      worktree: path2,
      baseBranch: 'main',
      architecturalGlobs: ['apps/web/src/router.tsx'],
    });
    expect(stats.architecturalPaths).toEqual(['apps/web/src/router.tsx']);
    expect(riskTier(stats, 'feature')).toBe('large');
  });

  it('flags modified existing test files that are not in the card scope', async () => {
    const path = await setup();
    writeFileSync(join(path, 'test', 'existing.test.ts'), '// changed\n');
    sh(path, 'git', ['commit', '-am', 'touch test']);
    const stats = await computeDiffStats({ worktree: path, baseBranch: 'main', architecturalGlobs: [] });
    expect(stats.outOfScopeTestChange).toBe(true);
    const inScope = await computeDiffStats({
      worktree: path,
      baseBranch: 'main',
      architecturalGlobs: [],
      affectedAreas: 'test/existing.test.ts',
    });
    expect(inScope.outOfScopeTestChange).toBeUndefined();
  });

  it('counts the changed test files (HR: test coverage of the changes)', async () => {
    const path = await setup();
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src', 'greet.ts'), 'export const g = 1;\n');
    writeFileSync(join(path, 'src', 'greet.test.ts'), 'it("g", () => {});\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'code and test']);
    const stats = await computeDiffStats({ worktree: path, baseBranch: 'main', architecturalGlobs: [] });
    expect(stats).toMatchObject({ files: 2, testFiles: 1 });
  });
});

describe('server-supplied values are untrusted (review M1)', () => {
  const roots = () => {
    const root = join(tmp(), 'worktrees');
    mkdirSync(root, { recursive: true });
    return root;
  };

  it('refuses option-like and malformed branch names before running git', async () => {
    const repo = makeRepo();
    const root = roots();
    for (const branchName of ['--upload-pack=touch /tmp/pwned', '-D', 'a..b', 'a b']) {
      await expect(
        ensureWorktree({
          repoPath: repo.clone,
          spec: spec({ branchName }),
          defaultPath: join(root, 'p', 'TOY-1'),
          roots: [root],
        }),
      ).rejects.toThrow(/unsafe branch/);
    }
    await expect(
      ensureWorktree({
        repoPath: repo.clone,
        spec: spec({ baseBranch: '--orphan=x' }),
        defaultPath: join(root, 'p', 'TOY-1'),
        roots: [root],
      }),
    ).rejects.toThrow(/unsafe base/);
  });

  it('never creates or deletes outside the worktrees directory (reuse path with ..)', async () => {
    const repo = makeRepo();
    const root = roots();
    const victim = join(tmp(), 'victim');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'precious.txt'), 'keep');
    await expect(
      ensureWorktree({
        repoPath: repo.clone,
        spec: spec({ mode: 'reuse', path: join(root, '..', 'victim') }),
        defaultPath: join(root, 'p', 'TOY-1'),
        roots: [root],
      }),
    ).rejects.toBeInstanceOf(WorktreeError);
    // an absolute path elsewhere, as a manipulated server would send it
    await expect(
      ensureWorktree({
        repoPath: repo.clone,
        spec: spec({ mode: 'reuse', path: victim }),
        defaultPath: join(root, 'p', 'TOY-1'),
        roots: [root],
      }),
    ).rejects.toBeInstanceOf(WorktreeError);
    expect(existsSync(join(victim, 'precious.txt'))).toBe(true);
    await expect(removeWorktree({ path: victim, roots: [root] })).rejects.toThrow(/outside/);
    expect(existsSync(join(victim, 'precious.txt'))).toBe(true);
  });

  it('does not follow a symlink out of the worktrees directory', async () => {
    const root = roots();
    const victim = join(tmp(), 'victim2');
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, 'precious.txt'), 'keep');
    symlinkSync(victim, join(root, 'link'));
    await expect(removeWorktree({ path: join(root, 'link'), roots: [root] })).rejects.toThrow(/outside/);
    expect(existsSync(join(victim, 'precious.txt'))).toBe(true);
  });
});
