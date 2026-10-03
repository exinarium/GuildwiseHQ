import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RebaseConflictError, rebaseOntoBase } from '../src/git/rebase.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const spec = {
  mode: 'create' as const,
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: 'x',
  baseBranch: 'main',
  branchName: 'aom/toy-1-x',
};

/** Pushes a commit to origin/main from a second clone. */
function advanceOrigin(root: string, origin: string, file: string, content: string) {
  const other = join(tmp(), 'other');
  sh(root, 'git', ['clone', origin, other]);
  writeFileSync(join(other, file), content);
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', `change ${file}`]);
  sh(other, 'git', ['push', 'origin', 'main']);
}

describe('rebase step before test and finalize (section 13.6)', () => {
  it('rebases the card branch onto the fetched working branch', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, spec, defaultPath: path });
    writeFileSync(join(path, 'mine.txt'), 'mine');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'mine']);
    advanceOrigin(repo.root, repo.origin, 'theirs.txt', 'theirs');
    await rebaseOntoBase(path, 'main');
    expect(existsSync(join(path, 'theirs.txt'))).toBe(true);
    expect(sh(path, 'git', ['log', '--format=%s', '-3'])).toBe('mine\nchange theirs.txt\ninitial');
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('a changed working branch that conflicts: lists the files, aborts, leaves no half-done rebase', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, spec, defaultPath: path });
    writeFileSync(join(path, 'README.md'), '# mine\n');
    writeFileSync(join(path, 'ok.txt'), 'fine');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'edit readme']);
    const before = sh(path, 'git', ['rev-parse', 'HEAD']);
    advanceOrigin(repo.root, repo.origin, 'README.md', '# theirs\n');

    const err = await rebaseOntoBase(path, 'main').catch((e) => e);
    expect(err).toBeInstanceOf(RebaseConflictError);
    expect((err as RebaseConflictError).conflictedFiles).toEqual(['README.md']);
    // the branch is exactly as it was and no rebase is in progress
    expect(sh(path, 'git', ['rev-parse', 'HEAD'])).toBe(before);
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(path, '.git'))).toBe(true);
    expect(sh(path, 'git', ['rev-parse', '--git-path', 'rebase-merge'])).toBeTruthy();
    expect(existsSync(sh(path, 'git', ['rev-parse', '--git-path', 'rebase-merge']))).toBe(false);
    expect(sh(path, 'git', ['branch', '--show-current'])).toBe('aom/toy-1-x');
  });

  it('works without an origin remote (local base branch)', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['remote', 'remove', 'origin']);
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, spec, defaultPath: path });
    writeFileSync(join(path, 'a.txt'), 'a');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'a']);
    writeFileSync(join(repo.clone, 'b.txt'), 'b');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'b on main']);
    await rebaseOntoBase(path, 'main');
    expect(existsSync(join(path, 'b.txt'))).toBe(true);
  });
});
