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

export interface GuardInput {
  worktree: string;
  roleKey: string;
  permissions: Pick<AgentPermissions, 'mayCommit'>;
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

  const branch = await currentBranch(input.worktree);
  if (branch !== input.branchName) {
    violations.push({
      rule: 'wrong_branch',
      detail: `The worktree must stay on ${input.branchName} but is on ${branch ?? 'a detached HEAD'}`,
    });
  }
  const now = await snapshotBranches(input.worktree);
  const moved = Object.keys(now).filter((b) => b !== input.branchName && input.branchesAtStart[b] !== now[b]);
  if (moved.length > 0) {
    violations.push({
      rule: 'commits_on_other_branch',
      detail: `Branches other than ${input.branchName} changed: ${moved.join(', ')}`,
    });
  }
  return violations;
}
