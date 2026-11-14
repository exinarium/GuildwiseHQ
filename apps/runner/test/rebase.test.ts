import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/** `git merge origin/main` that stops on a conflict (the caller resolves it). */
function mergeExpectingConflict(path: string) {
  try {
    sh(path, 'git', ['merge', '--no-edit', 'origin/main']);
  } catch {
    // conflict: resolved by the test
  }
}

describe('rebase step before test and finalize (section 13.6)', () => {
  it('rebases the card branch onto the fetched working branch', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec, defaultPath: path });
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
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec, defaultPath: path });
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

  it('a card that already merged the working branch and resolved the conflict is left alone (P4-3)', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec, defaultPath: path });
    writeFileSync(join(path, 'README.md'), '# mine\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'edit readme']);
    advanceOrigin(repo.root, repo.origin, 'README.md', '# theirs\n');
    // The builder merges the working branch and settles the conflict in the merge commit.
    sh(path, 'git', ['fetch', 'origin', 'main']);
    mergeExpectingConflict(path);
    writeFileSync(join(path, 'README.md'), '# mine and theirs\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '--no-edit']);
    const before = sh(path, 'git', ['rev-parse', 'HEAD']);

    expect(await rebaseOntoBase(path, 'main')).toBe('up_to_date');
    expect(sh(path, 'git', ['rev-parse', 'HEAD'])).toBe(before);
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('a card with its own merge commit is brought up to date with a merge, keeping the resolution', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec, defaultPath: path });
    writeFileSync(join(path, 'README.md'), '# mine\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'edit readme']);
    advanceOrigin(repo.root, repo.origin, 'README.md', '# theirs\n');
    sh(path, 'git', ['fetch', 'origin', 'main']);
    mergeExpectingConflict(path);
    writeFileSync(join(path, 'README.md'), '# mine and theirs\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '--no-edit']);
    // The working branch moves on again with an unrelated change.
    advanceOrigin(repo.root, repo.origin, 'later.txt', 'later');

    expect(await rebaseOntoBase(path, 'main')).toBe('merged');
    expect(existsSync(join(path, 'later.txt'))).toBe(true);
    expect(sh(path, 'git', ['show', 'HEAD:README.md'])).toBe('# mine and theirs');
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('works without an origin remote (local base branch)', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['remote', 'remove', 'origin']);
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec, defaultPath: path });
    writeFileSync(join(path, 'a.txt'), 'a');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'a']);
    writeFileSync(join(repo.clone, 'b.txt'), 'b');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'b on main']);
    await rebaseOntoBase(path, 'main');
    expect(existsSync(join(path, 'b.txt'))).toBe(true);
  });
  it("two cards' changelog entries rebase without a conflict under the repository's own .gitattributes (merge=union)", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const repo = makeRepo();
    copyFileSync(join(repoRoot, '.gitattributes'), join(repo.clone, '.gitattributes'));
    copyFileSync(join(repoRoot, 'CHANGELOG.md'), join(repo.clone, 'CHANGELOG.md'));
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'changelog']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const changelog = readFileSync(join(repo.clone, 'CHANGELOG.md'), 'utf8');
    const add = (text: string, line: string) =>
      text.replace('## [Unreleased]\n', `## [Unreleased]\n\n${line}\n`);
    expect(add(changelog, 'x')).not.toBe(changelog);
    const path = join(tmp(), 'wt');
    await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec, defaultPath: path });
    writeFileSync(join(path, 'CHANGELOG.md'), add(changelog, '- Mine: card A.'));
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'mine']);
    advanceOrigin(repo.root, repo.origin, 'CHANGELOG.md', add(changelog, '- Theirs: card B.'));

    expect(await rebaseOntoBase(path, 'main')).toBe('rebased');
    const merged = readFileSync(join(path, 'CHANGELOG.md'), 'utf8');
    expect(merged).toContain('- Mine: card A.');
    expect(merged).toContain('- Theirs: card B.');
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
  });
});
