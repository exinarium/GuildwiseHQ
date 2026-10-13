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

/**
 * Branches the runner itself creates and moves in the shared .git (repository hygiene's saved-work and conflict
 * branches, integration branches): never the agent's doing. (Other cards' `aom/` branches advanced by their own shifts are
 * covered by {@link siblingWorktreeBranches}.)
 */
const RUNNER_OWNED_BRANCH = /^(guildwise\/saved-work\/|conflict\/|aom-integration\/)/;

/**
 * A branch whose new tip adds no commit beyond what the remote already has (a pull or fast-forward of the owner's
 * checkout or of hygiene) or what the branch had at the start (a reset backwards) is a sync, not agent work. Only
 * commits that are on no remote-tracking ref and were not on the branch before count.
 */
async function isSyncOnly(cwd: string, tip: string, before: string | undefined): Promise<boolean> {
  const args = ['rev-list', '--max-count=1', tip, '--not', '--remotes'];
  if (before) args.push(before);
  const r = await git(cwd, args);
  return r.exitCode === 0 && r.stdout.trim() === '';
}

export interface GuardInput {
  worktree: string;
  roleKey: string;
  permissions: Pick<AgentPermissions, 'mayCommit'> & { writableGlobs?: string[] | null };
  branchName: string;
  startSha: string;
  branchesAtStart: BranchSnapshot;
  e2eGlobs: string[];
  /**
   * Extra paths the role may write besides its `writableGlobs` (the architect: the project's investigation folder and the
   * card's report path, resolved by the server and sent in the brief).
   */
  extraWritableGlobs?: string[];
  /**
   * SHAs of `origin/<main>` the runner merged into this card branch during the shift (the "merge latest main first"
   * step, `aom git merge-main`). What a merge commit with such a second parent changed is main's work, not the agent's.
   */
  mainMergeShas?: string[];
}

/**
 * Output directories test runners (Playwright, mostly) write into the worktree. They are build artifacts, not
 * changes: they never count as a violation or an out-of-scope edit, and untracked ones are removed before the
 * shift-end autocommit so they are never committed.
 */
export const TEST_ARTIFACT_DIRS = ['test-results', 'playwright-report', 'blob-report'];
const ARTIFACT_RE = new RegExp(`(^|/)(${TEST_ARTIFACT_DIRS.join('|')})(/|$)`);
export const isTestArtifact = (path: string): boolean => ARTIFACT_RE.test(path);

/** Removes untracked test output directories (quietly: this is not a finding). Returns true when something was removed. */
export async function discardTestArtifacts(worktree: string): Promise<boolean> {
  const status = await git(worktree, ['status', '--porcelain', '--untracked-files=all']);
  const dirs = new Set<string>();
  for (const l of status.stdout.split('\n')) {
    if (!l.startsWith('?? ')) continue;
    const path = l.slice(3).replace(/^"|"$/g, '');
    const parts = path.split('/');
    const i = parts.findIndex((seg) => TEST_ARTIFACT_DIRS.includes(seg));
    if (i >= 0) dirs.add(parts.slice(0, i + 1).join('/'));
  }
  for (const d of dirs) await git(worktree, ['clean', '-fdxq', '--', d]);
  return dirs.size > 0;
}

/**
 * Paths that a merge commit of the recorded main branch brought in and nothing changed afterwards: main's own work (a
 * conflict resolution included), exempt from the role's write scope. A path edited again after the merge, or edited
 * without committing, is not exempt. Merge commits whose second parent is not a recorded main SHA never count.
 */
export async function mainMergeExemptPaths(
  worktree: string,
  startSha: string,
  mainShas: readonly string[],
): Promise<Set<string>> {
  const exempt = new Set<string>();
  if (mainShas.length === 0) return exempt;
  const log = await git(worktree, ['rev-list', '--merges', '--parents', `${startSha}..HEAD`]);
  for (const line of log.stdout.split('\n')) {
    const [sha, first, ...others] = line.trim().split(' ');
    if (!sha || !first || !others.some((p) => mainShas.includes(p))) continue;
    const brought = await git(worktree, ['diff', '--name-only', first, sha]);
    const after = new Set(
      (await git(worktree, ['diff', '--name-only', sha, 'HEAD'])).stdout.split('\n').filter(Boolean),
    );
    for (const p of brought.stdout.split('\n')) if (p.trim() && !after.has(p.trim())) exempt.add(p.trim());
  }
  return exempt;
}

/** Changed paths: committed since the shift start plus uncommitted (tracked and untracked), minus test output dirs. */
export async function changedPaths(
  worktree: string,
  startSha: string,
  mainMergeShas: readonly string[] = [],
): Promise<string[]> {
  const committed = await git(worktree, ['diff', '--name-only', `${startSha}..HEAD`]);
  const dirty = await git(worktree, ['status', '--porcelain', '--untracked-files=all']);
  const exempt = await mainMergeExemptPaths(worktree, startSha, mainMergeShas);
  const out = new Set<string>();
  for (const l of committed.stdout.split('\n')) if (l.trim() && !exempt.has(l.trim())) out.add(l.trim());
  for (const l of dirty.stdout.split('\n')) {
    if (l.length > 3) out.add(l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() as string);
  }
  return [...out].filter((p) => !isTestArtifact(p));
}

/**
 * The globs a role may change, or null for the whole worktree. Testers use the project's E2E globs (resolved by the
 * runner); every other role, built-in or custom, uses its definition's `writableGlobs` (an empty list means nothing).
 */
export function effectiveWritableGlobs(input: GuardInput): string[] | null {
  if (input.roleKey === 'tester') return input.e2eGlobs.length ? input.e2eGlobs : ['!**'];
  const g = input.permissions.writableGlobs;
  if (g === undefined || g === null) return null;
  const all = [...g, ...(input.extraWritableGlobs ?? [])];
  return all.length ? all : ['!**'];
}

/**
 * Paths a path-scoped role changed outside its scope (tester: E2E globs; any role with `writableGlobs`, such as the
 * writer or a custom role); empty for unscoped roles. The guard rejects these, and the runner discards them instead
 * of auto-committing them.
 */
export function outOfScope(input: GuardInput, changed: string[]): string[] {
  const globs = effectiveWritableGlobs(input);
  if (!globs) return [];
  const inScope = picomatch(globs, { dot: true });
  return changed.filter((p) => !inScope(p));
}

/**
 * A role that may not commit leaves nothing behind: whatever it changed (committed, staged, edited, untracked) is
 * rolled back to the start of the shift. The worktree returns to its branch first so a stray checkout cannot make
 * the reset hit another branch. Returns true when something had to be undone.
 */
export async function resetReadOnlyWorktree(input: {
  worktree: string;
  branchName: string;
  startSha: string;
}): Promise<boolean> {
  const head = (await git(input.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  const dirty = (await git(input.worktree, ['status', '--porcelain', '--untracked-files=all'])).stdout.trim();
  const branch = await currentBranch(input.worktree);
  if (head === input.startSha && !dirty && branch === input.branchName) return false;
  await git(input.worktree, ['checkout', '-f', input.branchName]);
  await git(input.worktree, ['reset', '--hard', input.startSha]);
  await git(input.worktree, ['clean', '-fd']);
  return true;
}

/**
 * Throws away out-of-scope changes (uncommitted edits, untracked files and out-of-scope edits already committed since
 * `startSha`) so that the shift-end autocommit never commits them. Returns the discarded paths.
 */
export async function discardOutOfScope(input: GuardInput): Promise<string[]> {
  const bad = outOfScope(input, await changedPaths(input.worktree, input.startSha, input.mainMergeShas));
  for (const p of bad) {
    const atStart = await git(input.worktree, ['cat-file', '-e', `${input.startSha}:${p}`]);
    if (atStart.exitCode === 0) {
      await git(input.worktree, ['checkout', input.startSha, '--', p]);
    } else {
      await git(input.worktree, ['rm', '-rf', '--cached', '--ignore-unmatch', '--', p]);
      await git(input.worktree, ['clean', '-fdq', '--', p]);
    }
  }
  return bad;
}

/** Post-shift guard (docs/ARCHITECTURE.md section 13.7). Returns the violations; empty means the report may go ahead. */
export async function runGuard(input: GuardInput): Promise<GuardViolation[]> {
  const violations: GuardViolation[] = [];
  // A main-branch merge the architect left half done (conflict markers, no merge commit) must not be handed on. While it
  // is in progress the files it brought in sit in the index, so no other path check is meaningful: this is the finding.
  if (
    input.roleKey === 'architect' &&
    (await git(input.worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).exitCode === 0
  ) {
    return [
      {
        rule: 'merge_unresolved',
        detail:
          'A merge of the main branch is still in progress in the worktree: resolve the conflicts, `git add` them, run `git commit --no-edit` and then `aom git verify-merge`',
      },
    ];
  }
  const head = (await git(input.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  const changed = await changedPaths(input.worktree, input.startSha, input.mainMergeShas);

  if (!input.permissions.mayCommit && (head !== input.startSha || changed.length > 0)) {
    violations.push({
      rule: input.roleKey === 'reviewer' ? 'reviewer_modified_code' : 'readonly_role_modified_code',
      detail: `This role must not change code but the worktree changed: ${changed.slice(0, 10).join(', ') || 'HEAD moved'}`,
    });
  }

  if (input.roleKey === 'tester') {
    const bad = outOfScope(input, changed);
    if (bad.length > 0) {
      violations.push({
        rule: 'tester_edited_non_e2e',
        detail: `Testers may only change end-to-end tests (${input.e2eGlobs.join(', ') || 'none configured'}); changed: ${bad.slice(0, 10).join(', ')}`,
      });
    }
  }

  // Any other role with a write scope (writers: documentation; custom roles: their definition's writable globs).
  if (input.roleKey !== 'tester' && effectiveWritableGlobs(input)) {
    const bad = outOfScope(input, changed);
    if (bad.length > 0) {
      violations.push({
        rule:
          input.roleKey === 'writer'
            ? 'writer_edited_non_docs'
            : input.roleKey === 'architect'
              ? 'architect_edited_non_docs'
              : 'edited_outside_writable_globs',
        detail: `${input.roleKey === 'writer' ? 'Writers may only change documentation' : input.roleKey === 'architect' ? 'The architect may only change documentation and its report (never product code or tests, except main-branch merge conflicts)' : 'This role may only change paths matching'} (${effectiveWritableGlobs(input)?.join(', ') || 'nothing'}); changed: ${bad.slice(0, 10).join(', ')}`,
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
  const moved: string[] = [];
  for (const b of Object.keys(now)) {
    if (b === input.branchName || siblings.has(b) || input.branchesAtStart[b] === now[b]) continue;
    if (RUNNER_OWNED_BRANCH.test(b)) continue;
    if (await isSyncOnly(input.worktree, now[b] as string, input.branchesAtStart[b])) continue;
    moved.push(b);
  }
  if (moved.length > 0) {
    violations.push({
      rule: 'commits_on_other_branch',
      detail: `Branches other than ${input.branchName} changed: ${moved.join(', ')}`,
    });
  }
  return violations;
}
