import type { AgentPermissions, GuardViolation } from '@aom/shared';
import picomatch from 'picomatch';
import { currentBranch, git } from '../git/git.ts';

export interface BranchSnapshot {
  [branch: string]: string;
}

export async function snapshotBranches(cwd: string): Promise<BranchSnapshot> {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads']);
  const snap: BranchSnapshot = {};
  for (const line of r.stdout.split('\n')) {
    const [name, sha] = line.trim().split(' ');
    if (name && sha) snap[name] = sha;
  }
  return snap;
}

/**
 * Branches checked out in linked worktrees other than `worktree` (the main clone is not a linked worktree).
 * Concurrent shifts of the same repo share one ref store, so commits those shifts make move these branches
 * legitimately during this shift; they belong to other cards and are not this agent's doing.
 */
export async function siblingWorktreeBranches(worktree: string): Promise<Set<string>> {
  const r = await git(worktree, ['worktree', 'list', '--porcelain']);
  const out = new Set<string>();
  const blocks = r.stdout.split(/\n\n+/).filter(Boolean);
  const self = (await git(worktree, ['rev-parse', '--show-toplevel'])).stdout.trim();
  for (const block of blocks.slice(1)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (branch && path && path !== self) out.add(branch);
  }
  return out;
}

export interface GuardInput {
  worktree: string;
  roleKey: string;
  permissions: Pick<AgentPermissions, 'mayCommit'> & { writableGlobs?: string[] | null };
  branchName: string;
  startSha: string;
  branchesAtStart: BranchSnapshot;
  e2eGlobs: string[];
}

/** Changed paths: committed since the shift start plus uncommitted (tracked and untracked). */
export async function changedPaths(worktree: string, startSha: string): Promise<string[]> {
  const committed = await git(worktree, ['diff', '--name-only', `${startSha}..HEAD`]);
  const dirty = await git(worktree, ['status', '--porcelain', '--untracked-files=all']);
  const out = new Set<string>();
  for (const l of committed.stdout.split('\n')) if (l.trim()) out.add(l.trim());
  for (const l of dirty.stdout.split('\n')) {
    if (l.length > 3) out.add(l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() as string);
  }
  return [...out];
}

/** Post-shift guard (docs/ARCHITECTURE.md section 13.7). Returns the violations; empty means the report may go ahead. */
export async function runGuard(input: GuardInput): Promise<GuardViolation[]> {
  const violations: GuardViolation[] = [];
  const head = (await git(input.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  const changed = await changedPaths(input.worktree, input.startSha);

  if (!input.permissions.mayCommit && (head !== input.startSha || changed.length > 0)) {
    violations.push({
      rule: input.roleKey === 'reviewer' ? 'reviewer_modified_code' : 'readonly_role_modified_code',
      detail: `This role must not change code but the worktree changed: ${changed.slice(0, 10).join(', ') || 'HEAD moved'}`,
    });
  }

  if (input.roleKey === 'tester') {
    const isE2e = picomatch(input.e2eGlobs.length ? input.e2eGlobs : ['!**'], { dot: true });
    const bad = changed.filter((p) => !isE2e(p));
    if (bad.length > 0) {
      violations.push({
        rule: 'tester_edited_non_e2e',
        detail: `Testers may only change end-to-end tests (${input.e2eGlobs.join(', ') || 'none configured'}); changed: ${bad.slice(0, 10).join(', ')}`,
      });
    }
  }

  // Writers change documentation only (their role's writable globs).
  if (input.roleKey === 'writer' && input.permissions.writableGlobs?.length) {
    const isDoc = picomatch(input.permissions.writableGlobs, { dot: true });
    const bad = changed.filter((p) => !isDoc(p));
    if (bad.length > 0) {
      violations.push({
        rule: 'writer_edited_non_docs',
        detail: `Writers may only change documentation (${input.permissions.writableGlobs.join(', ')}); changed: ${bad.slice(0, 10).join(', ')}`,
      });
    }
  }

  // Builders never do E2E testing: the tester owns the E2E paths (spec "Testing strategy").
  if (input.roleKey === 'builder' && input.e2eGlobs.length > 0) {
    const isE2e = picomatch(input.e2eGlobs, { dot: true });
    const touched = changed.filter((p) => isE2e(p));
    if (touched.length > 0) {
      violations.push({
        rule: 'builder_edited_e2e',
        detail: `Builders must not write or change end-to-end tests (${input.e2eGlobs.join(', ')}); changed: ${touched.slice(0, 10).join(', ')}`,
      });
    }
  }

  const branch = await currentBranch(input.worktree);
  if (branch !== input.branchName) {
    violations.push({
      rule: 'wrong_branch',
      detail: `The worktree must stay on ${input.branchName} but is on ${branch ?? 'a detached HEAD'}`,
    });
  }
  const now = await snapshotBranches(input.worktree);
  const siblings = await siblingWorktreeBranches(input.worktree);
  const moved = Object.keys(now).filter(
    (b) => b !== input.branchName && !siblings.has(b) && input.branchesAtStart[b] !== now[b],
  );
  if (moved.length > 0) {
    violations.push({
      rule: 'commits_on_other_branch',
      detail: `Branches other than ${input.branchName} changed: ${moved.join(', ')}`,
    });
  }
  return violations;
}
