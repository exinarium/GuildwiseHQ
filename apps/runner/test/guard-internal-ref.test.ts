import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { type GuardInput, runGuard, snapshotBranches, workRefGuardInput } from '../src/shifts/guard.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const role = (k: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === k);
  if (!r) throw new Error(k);
  return r;
};

/** A card worktree on `branchName`; the guard runs as an intake card (clientRef) unless `extra` says otherwise. */
async function setup(opts: { roleKey?: string; branchName?: string; extra?: Partial<GuardInput> } = {}) {
  const roleKey = opts.roleKey ?? 'builder';
  const branchName = opts.branchName ?? 'aom/ABC-1-add-thing';
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
      branchName,
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
      branchName,
      startSha,
      branchesAtStart,
      e2eGlobs: ['e2e/**'],
      baseBranch: 'main',
      cardRef: 'TOY-1',
      projectKey: 'TOY',
      ownTicketBranchPart: 'ABC-1',
      clientRef: 'ABC-1',
      startedAtMs: Date.now() - 1000,
      ...opts.extra,
    });
  return { repo, path, guard, startSha };
}

const commit = (path: string, file: string, ...messages: string[]) => {
  writeFileSync(join(path, file), file);
  sh(path, 'git', ['add', '-A']);
  sh(path, 'git', ['commit', ...messages.flatMap((m) => ['-m', m])]);
  return sh(path, 'git', ['rev-parse', 'HEAD']);
};

const internal = <T extends { rule: string }>(vs: T[]): T[] =>
  vs.filter((v) => v.rule.startsWith('internal_ref_'));

describe('guard: internal ref on an intake card', () => {
  it('a clean history (ABC-1 commits, other keys in the body) passes', async () => {
    const { path, guard } = await setup();
    commit(path, 'a.ts', 'ABC-1: add a', 'See TOY-12 and TOY-85');
    expect(await guard()).toEqual([]);
  });

  it('a commit naming the internal ref is internal_ref_in_commits, listing the commit and the fix', async () => {
    const { path, guard } = await setup();
    commit(path, 'a.ts', 'ABC-1: add a');
    const bad = commit(path, 'b.ts', 'toy-1: add b');
    const vs = internal(await guard());
    expect(vs.map((v) => v.rule)).toEqual(['internal_ref_in_commits']);
    expect(vs[0]!.detail).toContain(bad.slice(0, 10));
    expect(vs[0]!.detail).toContain('"toy-1: add b"');
    expect(vs[0]!.detail).toContain('must use ABC-1, not TOY-1');
    expect(vs[0]!.detail).toContain('git commit --amend');
    expect(vs[0]!.detail).toContain('git reset --soft $(git merge-base HEAD origin/main)');
  });

  it('a commit naming the internal ref only in its body is flagged too', async () => {
    const { path, guard } = await setup();
    commit(path, 'a.ts', 'ABC-1: add a', 'Part of TOY-1');
    expect(internal(await guard()).map((v) => v.rule)).toEqual(['internal_ref_in_commits']);
  });

  it('commits from before the shift and on the base branch are not this shift’s', async () => {
    const repo = makeRepo();
    const path = join(tmp(), 'wt');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        remoteUrlNormalized: 'x',
        baseBranch: 'main',
        branchName: 'aom/ABC-1-x',
      },
      defaultPath: path,
    });
    commit(path, 'old.ts', 'TOY-1: from an earlier shift');
    const startSha = sh(path, 'git', ['rev-parse', 'HEAD']);
    const vs = await runGuard({
      worktree: path,
      roleKey: 'builder',
      permissions: role('builder').permissions,
      branchName: 'aom/ABC-1-x',
      startSha,
      branchesAtStart: await snapshotBranches(path),
      e2eGlobs: [],
      baseBranch: 'main',
      cardRef: 'TOY-1',
      clientRef: 'ABC-1',
    });
    expect(internal(vs)).toEqual([]);
  });

  it('a branch the shift committed on with the internal ref in its name is internal_ref_in_branch', async () => {
    const { path, guard } = await setup();
    sh(path, 'git', ['checkout', '-q', '-b', 'aom/toy-1-backup']);
    commit(path, 'a.ts', 'ABC-1: add a');
    sh(path, 'git', ['checkout', '-q', 'aom/ABC-1-add-thing']);
    const vs = internal(await guard());
    expect(vs.map((v) => v.rule)).toEqual(['internal_ref_in_branch']);
    expect(vs[0]!.detail).toContain('aom/toy-1-backup');
    expect(vs[0]!.detail).toContain('Work on aom/ABC-1-add-thing');
  });

  it('checking out a key-named branch names it (beside wrong_branch)', async () => {
    const { path, guard } = await setup();
    sh(path, 'git', ['checkout', '-q', '-b', 'fix/TOY-1-x']);
    const vs = await guard();
    expect(vs.map((v) => v.rule)).toContain('wrong_branch');
    const ir = internal(vs);
    expect(ir.map((v) => v.rule)).toEqual(['internal_ref_in_branch']);
    expect(ir[0]!.detail).toContain('fix/TOY-1-x');
  });

  it('a longer key in a branch name is not the card’s ref', async () => {
    const { path, guard } = await setup();
    sh(path, 'git', ['branch', 'notes/toy-12-x']);
    expect(internal(await guard())).toEqual([]);
  });

  it('the assigned card branch is never flagged, even with the internal ref (legacy name)', async () => {
    const { path, guard } = await setup({ branchName: 'aom/toy-1-old' });
    commit(path, 'a.ts', 'ABC-1: add a');
    expect(await guard()).toEqual([]);
  });

  it('a role that may not commit is not checked for internal refs', async () => {
    const { guard } = await setup({ roleKey: 'reviewer' });
    expect(internal(await guard())).toEqual([]);
  });
});

describe('guard: non-intake card', () => {
  it('commits and branches with its own project key raise no violation', async () => {
    const { path, guard } = await setup({
      branchName: 'aom/toy-1-x',
      extra: { clientRef: undefined, ownTicketBranchPart: undefined },
    });
    commit(path, 'a.ts', 'TOY-1: add a');
    expect(await guard()).toEqual([]);
  });
});

describe('workRefGuardInput: clientRef', () => {
  it('is set for a client ref that differs from the card ref', () => {
    expect(workRefGuardInput({ ref: 'TOY-1', workRef: 'ABC-1', isClientRef: true }, {})).toEqual({
      ownTicketBranchPart: 'ABC-1',
      clientRef: 'ABC-1',
    });
  });

  it('is not set for a non-intake card, a ticket equal to the ref, or without the card ref', () => {
    expect(workRefGuardInput({ ref: 'TOY-1', workRef: 'TOY-1', isClientRef: false }, {})).toEqual({});
    expect(
      workRefGuardInput({ ref: 'TOY-1', workRef: 'toy-1', isClientRef: true }, {}).clientRef,
    ).toBeUndefined();
    expect(workRefGuardInput({ workRef: 'ABC-1', isClientRef: true }, {})).toEqual({
      ownTicketBranchPart: 'ABC-1',
    });
  });
});
