import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { autoCommit } from '../src/shifts/autocommit.ts';
import {
  cardRefOfBranch,
  discardOutOfScope,
  discardTestArtifacts,
  resetReadOnlyWorktree,
  runGuard,
  snapshotBranches,
} from '../src/shifts/guard.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();
const role = (k: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === k);
  if (!r) throw new Error(k);
  return r;
};

async function setup(roleKey: string) {
  const repo = makeRepo();
  const path = join(tmp(), 'wt');
  const w = await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      remoteUrlNormalized: 'x',
      baseBranch: 'main',
      branchName: 'aom/toy-1-x',
    },
    defaultPath: path,
  });
  const startSha = w.headSha;
  const branchesAtStart = await snapshotBranches(path);
  const guard = () =>
    runGuard({
      worktree: path,
      roleKey,
      permissions: role(roleKey).permissions,
      branchName: 'aom/toy-1-x',
      startSha,
      branchesAtStart,
      e2eGlobs: ['e2e/**'],
    });
  return { repo, path, guard };
}

describe('guard', () => {
  it('a clean builder worktree passes, committed or not', async () => {
    const { path, guard } = await setup('builder');
    expect(await guard()).toEqual([]);
    writeFileSync(join(path, 'a.ts'), 'a');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'a']);
    writeFileSync(join(path, 'b.ts'), 'b');
    expect(await guard()).toEqual([]);
  });

  it('reviewer: uncommitted file, edited file or new commit is reviewer_modified_code', async () => {
    const a = await setup('reviewer');
    expect(await a.guard()).toEqual([]);
    writeFileSync(join(a.path, 'x.txt'), 'x');
    expect((await a.guard()).map((v) => v.rule)).toEqual(['reviewer_modified_code']);

    const b = await setup('reviewer');
    writeFileSync(join(b.path, 'README.md'), 'edited');
    expect((await b.guard())[0]?.rule).toBe('reviewer_modified_code');

    const c = await setup('reviewer');
    writeFileSync(join(c.path, 'x.txt'), 'x');
    sh(c.path, 'git', ['add', '-A']);
    sh(c.path, 'git', ['commit', '-m', 'sneaky']);
    expect((await c.guard())[0]?.rule).toBe('reviewer_modified_code');
  });

  it('tester: only e2e paths may change', async () => {
    const { path, guard } = await setup('tester');
    mkdirSync(join(path, 'e2e'), { recursive: true });
    writeFileSync(join(path, 'e2e', 'a.spec.ts'), 'ok');
    expect(await guard()).toEqual([]);
    writeFileSync(join(path, 'src.ts'), 'not e2e');
    const v = await guard();
    expect(v.map((x) => x.rule)).toEqual(['tester_edited_non_e2e']);
    expect(v[0]?.detail).toContain('src.ts');
  });

  it('any role: switching branches or committing on another branch is flagged', async () => {
    const { repo, path, guard } = await setup('builder');
    sh(path, 'git', ['checkout', '-b', 'rogue']);
    expect((await guard()).map((v) => v.rule)).toContain('wrong_branch');
    writeFileSync(join(path, 'r.txt'), 'r');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'rogue work']);
    sh(path, 'git', ['checkout', 'aom/toy-1-x']);
    expect((await guard()).map((v) => v.rule)).toEqual(['commits_on_other_branch']); // the new branch itself
    sh(path, 'git', ['branch', '-D', 'rogue']);
    expect(await guard()).toEqual([]);
    // commit on main in the main clone while the shift runs
    writeFileSync(join(repo.clone, 'm.txt'), 'm');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'on main']);
    expect((await guard()).map((v) => v.rule)).toContain('commits_on_other_branch');
  });
});

describe('guard: runner housekeeping in the shared .git is not the agent', () => {
  it('a saved-work branch and a pull of the working branch during the shift pass; a real commit on another branch is still flagged', async () => {
    const { repo, guard } = await setup('builder');
    // repository hygiene in the owner's checkout: saved-work branch ...
    writeFileSync(join(repo.clone, 'wip.txt'), 'w');
    sh(repo.clone, 'git', ['checkout', '-b', 'guildwise/saved-work/2026-10-13']);
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'chore: saved work (Guildwise HQ hygiene)']);
    sh(repo.clone, 'git', ['checkout', 'main']);
    // ... and a fast-forward of main from origin
    const other = join(tmp(), 'other');
    sh(repo.root, 'git', ['clone', repo.origin, other]);
    writeFileSync(join(other, 'theirs.txt'), 't');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', 'remote work']);
    sh(other, 'git', ['push', 'origin', 'main']);
    sh(repo.clone, 'git', ['pull', '--ff-only', 'origin', 'main']);
    expect(await guard()).toEqual([]);
    // the agent really commits on main
    writeFileSync(join(repo.clone, 'm.txt'), 'm');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'agent work on main']);
    expect((await guard()).map((v) => v.rule)).toEqual(['commits_on_other_branch']);
  });
});

describe('guard with concurrent shifts', () => {
  it("commits on another card's linked worktree branch are not a violation", async () => {
    const { repo, guard } = await setup('builder');
    const otherPath = join(tmp(), 'wt-other');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        remoteUrlNormalized: 'x',
        baseBranch: 'main',
        branchName: 'aom/toy-2-y',
      },
      defaultPath: otherPath,
    });
    writeFileSync(join(otherPath, 'o.txt'), 'o');
    sh(otherPath, 'git', ['add', '-A']);
    sh(otherPath, 'git', ['commit', '-m', 'other card']);
    expect(await guard()).toEqual([]);
  });
});

describe('autocommit', () => {
  it('commits leftovers as the owner with a plain message; no-op when clean', async () => {
    const { path } = await setup('builder');
    const env = {
      GIT_AUTHOR_NAME: 'Pieter Jordaan',
      GIT_AUTHOR_EMAIL: 'pieter@example.test',
      GIT_COMMITTER_NAME: 'Pieter Jordaan',
      GIT_COMMITTER_EMAIL: 'pieter@example.test',
    };
    const input = {
      worktree: path,
      ticket: 'DCPL-4276',
      env,
    };
    expect((await autoCommit(input)).committed).toBe(false);
    writeFileSync(join(path, 'left.txt'), 'l');
    expect((await autoCommit(input)).committed).toBe(true);
    expect(sh(path, 'git', ['log', '-1', '--format=%s|%an|%cn'])).toBe(
      'DCPL-4276: Work in progress|Pieter Jordaan|Pieter Jordaan',
    );
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
  });
});

describe('writable globs are enforced for every role (review M3)', () => {
  it('a custom role with writableGlobs may only change matching paths', async () => {
    const { path, repo } = await setup('builder');
    const startSha = sh(path, 'git', ['rev-parse', 'HEAD']);
    const input = (globs: string[] | null) => ({
      worktree: path,
      roleKey: 'release-notes',
      permissions: { mayCommit: true, writableGlobs: globs },
      branchName: 'aom/toy-1-x',
      startSha,
      branchesAtStart: {},
      e2eGlobs: [],
    });
    mkdirSync(join(path, 'notes'), { recursive: true });
    writeFileSync(join(path, 'notes', 'a.md'), 'ok');
    expect((await runGuard(input(['notes/**']))).map((v) => v.rule)).not.toContain(
      'edited_outside_writable_globs',
    );
    writeFileSync(join(path, 'src.ts'), 'nope');
    const v = await runGuard(input(['notes/**']));
    expect(v.map((x) => x.rule)).toContain('edited_outside_writable_globs');
    expect(v.find((x) => x.rule === 'edited_outside_writable_globs')?.detail).toContain('src.ts');
    // null means the whole worktree; an empty list means nothing
    expect((await runGuard(input(null))).map((x) => x.rule)).not.toContain('edited_outside_writable_globs');
    expect((await runGuard(input([]))).map((x) => x.rule)).toContain('edited_outside_writable_globs');
    // and the runner throws the out-of-scope edit away instead of committing it
    const dropped = await discardOutOfScope(input(['notes/**']));
    expect(dropped.discarded).toEqual(['src.ts']);
    expect(repo.clone).toBeTruthy();
  });
});

describe('read-only roles are rolled back (review M4)', () => {
  it('reset --hard to the start sha and clean, also after a commit or a stray branch', async () => {
    const { path } = await setup('reviewer');
    const startSha = sh(path, 'git', ['rev-parse', 'HEAD']);
    const input = { worktree: path, branchName: 'aom/toy-1-x', startSha };
    expect(await resetReadOnlyWorktree(input)).toBe(false);

    writeFileSync(join(path, 'x.txt'), 'untracked');
    writeFileSync(join(path, 'README.md'), 'edited');
    mkdirSync(join(path, 'newdir'));
    writeFileSync(join(path, 'newdir', 'n.txt'), 'n');
    sh(path, 'git', ['checkout', '-b', 'rogue']);
    writeFileSync(join(path, 'c.txt'), 'c');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'sneaky']);
    writeFileSync(join(path, 'again.txt'), 'dirty');

    expect(await resetReadOnlyWorktree(input)).toBe(true);
    expect(sh(path, 'git', ['rev-parse', 'HEAD'])).toBe(startSha);
    expect(sh(path, 'git', ['branch', '--show-current'])).toBe('aom/toy-1-x');
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(path, 'newdir'))).toBe(false);
    expect(existsSync(join(path, 'x.txt'))).toBe(false);
  });
});

describe('test output directories are artifacts, not changes', () => {
  it('are no violation for a tester, are not out of scope, and are removed before the autocommit', async () => {
    const { path, guard } = await setup('tester');
    for (const d of ['test-results', 'playwright-report', 'blob-report', 'apps/web/test-results']) {
      mkdirSync(join(path, d), { recursive: true });
      writeFileSync(join(path, d, 'out.txt'), 'x');
    }
    expect(await guard()).toEqual([]);
    const startSha = sh(path, 'git', ['rev-parse', 'HEAD']);
    const input = {
      worktree: path,
      roleKey: 'tester',
      permissions: role('tester').permissions,
      branchName: 'aom/toy-1-x',
      startSha,
      branchesAtStart: {},
      e2eGlobs: ['e2e/**'],
    };
    expect((await discardOutOfScope(input)).discarded).toEqual([]);
    expect(await discardTestArtifacts(path)).toBe(true);
    expect(existsSync(join(path, 'test-results'))).toBe(false);
    expect(existsSync(join(path, 'apps/web/test-results'))).toBe(false);
    expect((await autoCommit({ worktree: path, env: {} })).committed).toBe(false);
    expect(await discardTestArtifacts(path)).toBe(false);
  });
});

describe('guard: commits_on_other_branch attribution by card', () => {
  const key = 'TOY';
  async function twoCards(extra: { startedAtMs?: number | null; protectedBranches?: string[] } = {}) {
    const a = await setup('builder');
    const bPath = join(tmp(), 'wt-b');
    await ensureWorktree({
      repoPath: a.repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        remoteUrlNormalized: 'x',
        baseBranch: 'main',
        branchName: 'aom/toy-2-y',
      },
      defaultPath: bPath,
    });
    const startSha = sh(a.path, 'git', ['rev-parse', 'HEAD']).trim();
    const branchesAtStart = await snapshotBranches(a.path);
    const startedAtMs = extra.startedAtMs === null ? undefined : (extra.startedAtMs ?? Date.now());
    const guard = async () =>
      (
        await runGuard({
          worktree: a.path,
          roleKey: 'builder',
          permissions: role('builder').permissions,
          branchName: 'aom/toy-1-x',
          startSha,
          branchesAtStart,
          e2eGlobs: ['e2e/**'],
          cardRef: 'TOY-1',
          projectKey: key,
          ...(extra.protectedBranches ? { protectedBranches: extra.protectedBranches } : {}),
          ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        })
      ).filter((v) => v.rule === 'commits_on_other_branch');
    const commit = (wt: string, f: string) => {
      writeFileSync(join(wt, f), f);
      sh(wt, 'git', ['add', '-A']);
      sh(wt, 'git', ['commit', '-m', f]);
    };
    return { ...a, bPath, guard, commit };
  }

  it('card B moving its backup or card branches does not refuse card A', async () => {
    const t = await twoCards();
    t.commit(t.bPath, 'b1.txt');
    sh(t.bPath, 'git', ['branch', 'backup/toy-2-partial', 'HEAD']);
    sh(t.bPath, 'git', ['branch', 'guildwise/toy-2-z', 'HEAD']);
    expect(await t.guard()).toEqual([]);
  });

  it('card B merging card A branch does not refuse card A', async () => {
    const t = await twoCards();
    t.commit(t.path, 'a1.txt');
    sh(t.bPath, 'git', ['merge', '--no-ff', '-m', 'merge a', 'aom/toy-1-x']);
    expect(await t.guard()).toEqual([]);
  });

  it("card A committing on card B's backup branch is refused", async () => {
    const t = await twoCards();
    sh(t.repo.clone, 'git', ['branch', 'backup/toy-2-partial', 'main']);
    sh(t.path, 'git', ['checkout', 'backup/toy-2-partial']);
    t.commit(t.path, 'x.txt');
    sh(t.path, 'git', ['checkout', 'aom/toy-1-x']);
    const v = await t.guard();
    expect(v).toHaveLength(1);
    expect(v[0]?.detail).toContain('backup/toy-2-partial (commits made in this worktree)');
  });

  it("card A pointing card B's branch at its own commit is refused, also for a sibling branch", async () => {
    const t = await twoCards();
    sh(t.repo.clone, 'git', ['branch', 'aom/toy-2-old', 'main']);
    t.commit(t.path, 'a1.txt');
    sh(t.path, 'git', ['branch', '-f', 'aom/toy-2-old', 'HEAD']);
    expect((await t.guard())[0]?.detail).toContain('aom/toy-2-old');
    const t2 = await twoCards();
    t2.commit(t2.path, 'a1.txt');
    sh(t2.path, 'git', ['update-ref', 'refs/heads/aom/toy-2-y', 'HEAD']);
    expect((await t2.guard())[0]?.detail).toContain('aom/toy-2-y');
  });

  it('main and the base branch stay strict', async () => {
    const t = await twoCards({ protectedBranches: ['main', 'release/x'] });
    sh(t.repo.clone, 'git', ['branch', 'release/x', 'main']);
    expect(await t.guard()).toEqual([]);
    t.commit(t.repo.clone, 'm.txt');
    expect((await t.guard())[0]?.detail).toContain('main');
    const u = await twoCards({ protectedBranches: ['main', 'release/y'] });
    sh(u.repo.clone, 'git', ['branch', 'release/y', 'main']);
    sh(u.repo.clone, 'git', ['checkout', 'release/y']);
    u.commit(u.repo.clone, 'r.txt');
    expect((await u.guard())[0]?.detail).toContain('release/y');
  });

  it("card A's own branch and own-family backups are judged as before", async () => {
    const t = await twoCards();
    t.commit(t.path, 'a1.txt');
    expect(await t.guard()).toEqual([]);
    sh(t.path, 'git', ['branch', 'backup/toy-1-save', 'HEAD']);
    expect((await t.guard())[0]?.detail).toContain('backup/toy-1-save');
    const u = await twoCards();
    sh(u.path, 'git', ['checkout', '-b', 'rogue']);
    u.commit(u.path, 'r.txt');
    sh(u.path, 'git', ['checkout', 'aom/toy-1-x']);
    expect((await u.guard())[0]?.detail).toContain('rogue');
  });

  it('a commit made before the shift start does not count; without a start time it does', async () => {
    const t = await twoCards({ startedAtMs: Date.now() + 60_000 });
    sh(t.repo.clone, 'git', ['branch', 'aom/toy-2-old', 'main']);
    t.commit(t.path, 'a1.txt');
    sh(t.path, 'git', ['branch', '-f', 'aom/toy-2-old', 'HEAD']);
    expect(await t.guard()).toEqual([]);
    const u = await twoCards({ startedAtMs: null });
    sh(u.repo.clone, 'git', ['branch', 'aom/toy-2-old', 'main']);
    u.commit(u.path, 'a1.txt');
    sh(u.path, 'git', ['branch', '-f', 'aom/toy-2-old', 'HEAD']);
    expect(await u.guard()).toHaveLength(1);
  });

  it('without a HEAD reflog a foreign branch move is refused as provenance unknown', async () => {
    const t = await twoCards();
    sh(t.repo.clone, 'git', ['config', 'core.logAllRefUpdates', 'false']);
    t.commit(t.bPath, 'b1.txt');
    sh(t.bPath, 'git', ['branch', 'backup/toy-2-partial', 'HEAD']);
    const v = await t.guard();
    expect(v[0]?.detail).toContain('provenance unknown');
  });

  it('cardRefOfBranch uses the project key and a boundary', () => {
    expect(cardRefOfBranch('backup/gwp-63-partial-rebase-0c0bf3f8', 'GWP')).toBe('GWP-63');
    expect(cardRefOfBranch('aom/gwp-63-finalize', 'GWP')).toBe('GWP-63');
    expect(cardRefOfBranch('conflict/GWP-27-a1', 'GWP')).toBe('GWP-27');
    expect(cardRefOfBranch('aom/gwp-630-x', 'GWP')).toBe('GWP-630');
    expect(cardRefOfBranch('feat/video-1.3', 'GWP')).toBeNull();
    expect(cardRefOfBranch('release/1.5.0', 'GWP')).toBeNull();
    expect(cardRefOfBranch('aom/gwp-63-x', undefined)).toBeNull();
  });
});
