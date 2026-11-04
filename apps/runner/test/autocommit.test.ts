import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AUTOCOMMIT_MAX_DELETED_FILES,
  autoCommit,
  autoCommitRefusedNote,
  describeRefusal,
  unreportedWorkNote,
} from '../src/shifts/autocommit.ts';
import { cleanupTmp, sh, tmp } from './helpers.ts';

const calls: { args: string[]; env?: Record<string, string> }[] = [];
vi.mock('../src/git/git.ts', async (orig) => {
  const real = await orig<typeof import('../src/git/git.ts')>();
  return {
    ...real,
    git: (cwd: string, args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
      return real.git(cwd, args, opts);
    },
  };
});

cleanupTmp();

const env = {
  GIT_AUTHOR_NAME: 'a',
  GIT_AUTHOR_EMAIL: 'a@x.test',
  GIT_COMMITTER_NAME: 'a',
  GIT_COMMITTER_EMAIL: 'a@x.test',
};

/** A repo with `n` tracked files f0..f(n-1) (and a README), committed once. */
function repo(n: number): string {
  const dir = join(tmp(), 'r');
  mkdirSync(dir, { recursive: true });
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.name', 'a']);
  sh(dir, 'git', ['config', 'user.email', 'a@x.test']);
  writeFileSync(join(dir, 'README.md'), '# r\n');
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${i}.txt`), `file ${i}\n`);
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-qm', 'initial']);
  return dir;
}
const rm = (dir: string, from: number, count: number) => {
  for (let i = from; i < from + count; i++) sh(dir, 'rm', [`f${i}.txt`]);
};
const head = (dir: string) => sh(dir, 'git', ['rev-parse', 'HEAD']);
const staged = (dir: string) => sh(dir, 'git', ['diff', '--cached', '--name-status']);

describe('autoCommit: normal changes', () => {
  it('commits edits, additions and a few deletions as Work in progress', async () => {
    const dir = repo(40);
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `f${i}.txt`), 'edited\n');
    writeFileSync(join(dir, 'new1.txt'), 'n\n');
    writeFileSync(join(dir, 'new2.txt'), 'n\n');
    rm(dir, 10, 1);
    const r = await autoCommit({ worktree: dir, ticket: 'DCPL-4276', env });
    expect(r.committed).toBe(true);
    if (!r.committed) return;
    expect(r.sha).toBe(head(dir));
    expect(sh(dir, 'git', ['log', '-1', '--format=%s|%an'])).toBe('DCPL-4276: Work in progress|a');
    expect(sh(dir, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('commits without a ticket and reports clean when there is nothing', async () => {
    const dir = repo(3);
    expect(await autoCommit({ worktree: dir, env })).toEqual({ committed: false, skipped: 'clean' });
    writeFileSync(join(dir, 'x.txt'), 'x\n');
    expect((await autoCommit({ worktree: dir, env })).committed).toBe(true);
    expect(sh(dir, 'git', ['log', '-1', '--format=%s'])).toBe('Work in progress');
  });

  it('commits the deletion of one of the few files of a tiny repository (below the percentage floor)', async () => {
    const dir = repo(1);
    rm(dir, 0, 1);
    expect((await autoCommit({ worktree: dir, env })).committed).toBe(true);
  });

  it('a rename of 40 files is not a loss and is committed', async () => {
    const dir = repo(40);
    mkdirSync(join(dir, 'moved'));
    for (let i = 0; i < 40; i++) sh(dir, 'mv', [`f${i}.txt`, `moved/f${i}.txt`]);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(true);
  });

  it('deleting exactly the limit in a large repository is committed', async () => {
    const dir = repo(300);
    rm(dir, 0, AUTOCOMMIT_MAX_DELETED_FILES);
    expect((await autoCommit({ worktree: dir, env })).committed).toBe(true);
  });
});

describe('autoCommit: refusals leave everything as it is', () => {
  it('refuses more than the limit of deletions, commits nothing and keeps the index and the files', async () => {
    const dir = repo(40);
    const before = head(dir);
    rm(dir, 0, AUTOCOMMIT_MAX_DELETED_FILES + 1);
    writeFileSync(join(dir, 'untracked.txt'), 'u\n');
    const stagedBefore = staged(dir);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(false);
    const f = r.refused;
    expect(f?.reason).toBe('mass_deletion');
    expect(f?.deleted).toBe(26);
    expect(f?.tracked).toBe(41);
    expect(f?.added).toBe(1);
    expect(head(dir)).toBe(before);
    expect(staged(dir)).toBe(stagedBefore);
    expect(existsSync(join(dir, 'f0.txt'))).toBe(false);
    expect(existsSync(join(dir, 'untracked.txt'))).toBe(true);
    const porcelain = sh(dir, 'git', ['status', '--porcelain']).split('\n');
    expect(porcelain.filter((l) => l.trim().startsWith('D '))).toHaveLength(26);
    expect(porcelain).toContain('?? untracked.txt');
    if (!f) return;
    const note = autoCommitRefusedNote(f, { shiftId: 'shift-x', branch: 'aom/x', where: 'shift_end' });
    expect(note).toContain('shift-x');
    expect(note).toContain('deletes 26 of 41');
    expect(note).toContain('`f0.txt`');
  });

  it('refuses by percentage in a small repository (5 of 20 files)', async () => {
    const dir = repo(19);
    rm(dir, 0, 5);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused?.reason).toBe('mass_deletion');
    expect(r.refused?.deleted).toBe(5);
  });

  it('refuses a tree that equals the tree of an ancestor and leaves the index alone', async () => {
    const dir = repo(5);
    const first = head(dir);
    writeFileSync(join(dir, 'x.ts'), 'x\n');
    writeFileSync(join(dir, 'README.md'), '# changed\n');
    sh(dir, 'git', ['add', '-A']);
    sh(dir, 'git', ['commit', '-qm', 'B']);
    // restore the first commit's tree in the working tree only
    sh(dir, 'git', ['checkout', first, '--', '.']);
    sh(dir, 'git', ['rm', '-q', '--cached', '-f', 'x.ts']);
    sh(dir, 'rm', ['x.ts']);
    sh(dir, 'git', ['reset', '-q', '--mixed']);
    const before = head(dir);
    const stagedBefore = staged(dir);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused?.reason).toBe('tree_revert');
    expect(r.refused?.revertsTo).toBe(first);
    expect(head(dir)).toBe(before);
    expect(staged(dir)).toBe(stagedBefore);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# r\n');
    if (r.refused) expect(describeRefusal(r.refused)).toContain(first.slice(0, 7));
  });

  it('never runs reset, checkout, restore, clean, rm, stash or commit, and adds only on a temporary index', async () => {
    const dir = repo(40);
    rm(dir, 0, 30);
    calls.length = 0;
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused).toBeDefined();
    const names = calls.map((c) => c.args[0]);
    for (const bad of ['reset', 'checkout', 'restore', 'clean', 'rm', 'stash', 'commit', 'switch'])
      expect(names).not.toContain(bad);
    const adds = calls.filter((c) => c.args[0] === 'add');
    expect(adds.length).toBeGreaterThan(0);
    for (const a of adds) expect(a.env?.GIT_INDEX_FILE).toBeTruthy();
  });
});

describe('autoCommit: sandbox stubs', () => {
  it('stubs are not counted, not committed, and not a reason to commit', async () => {
    const dir = repo(40);
    // an empty untracked file that is a sandbox stub
    writeFileSync(join(dir, '.gitmodules'), '');
    expect(await autoCommit({ worktree: dir, env })).toEqual({ committed: false, skipped: 'clean' });
    writeFileSync(join(dir, 'f1.txt'), 'edited\n');
    const r = await autoCommit({ worktree: dir, env });
    expect(r.committed).toBe(true);
    expect(sh(dir, 'git', ['ls-files'])).not.toContain('.gitmodules');
  });

  it('26 deletions plus a stub: the deleted count is 26', async () => {
    const dir = repo(40);
    writeFileSync(join(dir, '.gitmodules'), '');
    rm(dir, 0, 26);
    const r = await autoCommit({ worktree: dir, env });
    expect(r.refused?.deleted).toBe(26);
  });
});

describe('unreportedWorkNote', () => {
  it('says the runner refused when the commit was refused', () => {
    const note = unreportedWorkNote(['a.ts'], { outcome: 'no_report', committed: false, refused: true });
    expect(note).toContain('refused to commit');
    expect(note).not.toContain('merge of the main branch');
  });
});
