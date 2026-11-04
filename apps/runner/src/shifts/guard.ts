import { type AgentPermissions, type GuardViolation, isRunnerOwnedBranch } from '@aom/shared';
import picomatch from 'picomatch';
import {
  statusLinesWithoutStubs,
  untrackedSandboxStubs,
  withoutSandboxStubs,
} from '../adapters/sandbox-placeholders.ts';
import { currentBranch, git } from '../git/git.ts';
import { baseTarget } from '../git/rebase.ts';

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
  /**
   * Tips of the card's base and working branch (local and origin/), recorded by the runner at the shift start and after
   * each runner fetch. A merge parent that is, or is an ancestor of, one of these is base-branch content.
   */
  baseTipShas?: string[];
  /** When the shift started (ms since epoch, taken with startSha): HEAD reflog entries since then are this shift's. */
  startedAtMs?: number;
  /**
   * The card's base (target) branch. Lets the builder e2e check compare against the merge-base with it instead of the
   * shift start: a revert of an e2e file to its base content is not an edit. Absent: every changed e2e path counts.
   */
  baseBranch?: string;
}

/**
 * Of the changed paths, those whose content in the worktree still differs from the merge-base with the base branch.
 * A path restored to its base content (or absent in both) is not a net change. Falls back to all paths when the
 * merge-base cannot be resolved.
 */
export async function netChangedFromBase(
  worktree: string,
  baseBranch: string | undefined,
  paths: string[],
): Promise<string[]> {
  if (!baseBranch || paths.length === 0) return paths;
  const target = await baseTarget(worktree, baseBranch);
  const mb = await git(worktree, ['merge-base', target, 'HEAD']);
  const base = mb.stdout.trim();
  if (mb.exitCode !== 0 || !base) return paths;
  const net: string[] = [];
  for (const p of paths) {
    const b = await git(worktree, ['rev-parse', '--verify', '--quiet', `${base}:${p}`]);
    const baseBlob = b.exitCode === 0 ? b.stdout.trim() : null;
    const exists =
      (
        await git(worktree, ['ls-files', '--others', '--cached', '--exclude-standard', '--', p])
      ).stdout.trim() !== '';
    let nowBlob: string | null = null;
    if (exists) {
      const h = await git(worktree, ['hash-object', '--', p]);
      nowBlob = h.exitCode === 0 ? h.stdout.trim() : null;
    }
    if (baseBlob !== nowBlob) net.push(p);
  }
  return net;
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

export interface MergeExemptOpts {
  mainShas?: readonly string[];
  baseTips?: readonly string[];
}

export interface MergeExemptions {
  /** Paths whose change since the shift start is main or base-branch content. */
  exempt: Set<string>;
  /** Where to restore a path from instead of the shift start (the latest exempt merge), so a discard never undoes a merge. */
  restoreFrom: Map<string, string>;
  /** Paths changed by hand inside a base merge commit: not exempt, judged normally. */
  handEdits: Set<string>;
}

export const exemptOpts = (input: GuardInput): MergeExemptOpts => ({
  ...(input.mainMergeShas ? { mainShas: input.mainMergeShas } : {}),
  ...(input.baseTipShas ? { baseTips: input.baseTipShas } : {}),
});

const lines = (out: string): string[] =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

async function diffNames(worktree: string, a: string, b: string): Promise<Set<string>> {
  return new Set(lines((await git(worktree, ['diff', '--name-only', a, b])).stdout));
}

/**
 * What merges of the recorded main branch or of the card's base/working branch brought in, and nothing changed
 * afterwards: that work is not the agent's, so it is exempt from the role's write scope.
 *
 * - Main merge (a parent is a recorded main sha): everything the merge brought in, a conflict resolution included.
 * - Base merge (a parent is, or is an ancestor of, a recorded base tip): the paths taken from the base side or changed
 *   on both sides (conflict resolution). A path changed by hand inside the merge commit stays judged.
 * - A fast-forward onto base content (no merge commit): the commits that are base history are exempt as well.
 * A path edited again after the merge, or edited without committing, is not exempt.
 */
export async function mergeExemptions(
  worktree: string,
  startSha: string,
  opts: MergeExemptOpts = {},
): Promise<MergeExemptions> {
  const res: MergeExemptions = { exempt: new Set(), restoreFrom: new Map(), handEdits: new Set() };
  const mainShas = opts.mainShas ?? [];
  const baseTips = [...new Set(opts.baseTips ?? [])];
  if (mainShas.length === 0 && baseTips.length === 0) return res;

  const baseCache = new Map<string, boolean>();
  const isBase = async (sha: string): Promise<boolean> => {
    const hit = baseCache.get(sha);
    if (hit !== undefined) return hit;
    let ok = false;
    for (const t of baseTips) {
      if (t === sha || (await git(worktree, ['merge-base', '--is-ancestor', sha, t])).exitCode === 0) {
        ok = true;
        break;
      }
    }
    baseCache.set(sha, ok);
    return ok;
  };

  const logArgs = ['rev-list', '--merges', '--parents', `${startSha}..HEAD`];
  if (baseTips.length) logArgs.push('--not', ...baseTips);
  const log = await git(worktree, logArgs);
  for (const line of lines(log.stdout)) {
    const [sha, first, ...others] = line.split(' ');
    if (!sha || !first || others.length === 0) continue;
    const brought = await diffNames(worktree, first, sha);
    const after = await diffNames(worktree, sha, 'HEAD');
    let candidates: Set<string>;
    if (others.some((p) => mainShas.includes(p))) {
      candidates = brought;
    } else {
      let baseParent: string | undefined;
      for (const p of others) {
        if (await isBase(p)) {
          baseParent = p;
          break;
        }
      }
      if (!baseParent) continue;
      const mb = await git(worktree, ['merge-base', first, baseParent]);
      const mergeBase = mb.exitCode === 0 ? mb.stdout.trim() : '';
      const baseChanged = mergeBase ? await diffNames(worktree, mergeBase, baseParent) : new Set<string>();
      const cardChanged = mergeBase ? await diffNames(worktree, mergeBase, first) : new Set<string>();
      const fromBase = await diffNames(worktree, baseParent, sha);
      candidates = new Set();
      for (const p of brought) {
        const hand = fromBase.has(p) && !(baseChanged.has(p) && cardChanged.has(p));
        if (hand) {
          res.handEdits.add(p);
          if (!res.restoreFrom.has(p)) res.restoreFrom.set(p, baseChanged.has(p) ? baseParent : first);
        } else candidates.add(p);
      }
    }
    for (const p of candidates) {
      if (!after.has(p)) res.exempt.add(p);
      else if (!res.restoreFrom.has(p)) res.restoreFrom.set(p, sha); // newest merge first
    }
  }

  // A fast-forward onto base content leaves no merge commit: the commits startSha..X are base history.
  if (baseTips.length) {
    let best: string | undefined;
    for (const t of baseTips) {
      const mb = await git(worktree, ['merge-base', 'HEAD', t]);
      const x = mb.exitCode === 0 ? mb.stdout.trim() : '';
      if (!x || x === startSha) continue;
      if ((await git(worktree, ['merge-base', '--is-ancestor', startSha, x])).exitCode !== 0) continue;
      if (!best || (await git(worktree, ['merge-base', '--is-ancestor', best, x])).exitCode === 0) best = x;
    }
    if (best) {
      const brought = await diffNames(worktree, startSha, best);
      const after = await diffNames(worktree, best, 'HEAD');
      for (const p of brought) {
        if (!after.has(p)) res.exempt.add(p);
        else if (!res.restoreFrom.has(p)) res.restoreFrom.set(p, best);
      }
    }
  }
  for (const p of res.handEdits) res.exempt.delete(p);
  return res;
}

/** Uncommitted paths (tracked and untracked), minus the sandbox stubs and test output dirs. */
async function dirtyPaths(worktree: string): Promise<string[]> {
  const dirty = await git(worktree, ['status', '--porcelain', '--untracked-files=all']);
  const out = new Set<string>();
  // the sandbox's empty mount stubs (.gitmodules, .bashrc, ...) are not changes (hotfix #77)
  const dirtyLines = withoutSandboxStubs(dirty.stdout.split('\n'), await untrackedSandboxStubs(worktree));
  for (const l of dirtyLines) {
    if (l.length > 3) out.add(l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() as string);
  }
  return [...out].filter((p) => !isTestArtifact(p));
}

/** Changed paths: committed since the shift start plus uncommitted (tracked and untracked), minus test output dirs. */
export async function changedPaths(
  worktree: string,
  startSha: string,
  opts: MergeExemptOpts = {},
): Promise<string[]> {
  const committed = await git(worktree, ['diff', '--name-only', `${startSha}..HEAD`]);
  const { exempt } = await mergeExemptions(worktree, startSha, opts);
  const out = new Set<string>();
  for (const l of committed.stdout.split('\n')) if (l.trim() && !exempt.has(l.trim())) out.add(l.trim());
  for (const p of await dirtyPaths(worktree)) out.add(p);
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
  const dirty = (await statusLinesWithoutStubs(input.worktree)).lines.length > 0;
  const branch = await currentBranch(input.worktree);
  if (head === input.startSha && !dirty && branch === input.branchName) return false;
  await git(input.worktree, ['checkout', '-f', input.branchName]);
  await git(input.worktree, ['reset', '--hard', input.startSha]);
  await git(input.worktree, ['clean', '-fd']);
  return true;
}

export interface DiscardResult {
  discarded: string[];
  /** Out of scope but left alone: not part of the shift's own changes (another process brought it onto the branch). */
  kept: string[];
  /** Set when nothing was discarded because HEAD left the shift's history. */
  skipped?: { reason: 'head_moved'; from: string; to: string };
}

/** Paths of the commits this worktree created since the shift started (HEAD reflog), or of its non-merge commits. */
async function ownCommitPaths(input: GuardInput): Promise<Set<string>> {
  const out = new Set<string>();
  const wt = input.worktree;
  const addCommit = async (c: string): Promise<void> => {
    const d = await git(wt, ['diff', '--name-only', `${c}^1`, c]);
    if (d.exitCode === 0) for (const p of lines(d.stdout)) out.add(p);
  };
  if (input.startedAtMs !== undefined) {
    const rl = await git(wt, ['reflog', 'show', '--date=unix', '--format=%H%x09%gd%x09%gs', 'HEAD']);
    if (rl.exitCode === 0) {
      const since = Math.floor(input.startedAtMs / 1000) - 1;
      for (const line of lines(rl.stdout)) {
        const [sha, sel, subject = ''] = line.split('\t');
        const ts = Number(/@\{(\d+)\}/.exec(sel ?? '')?.[1]);
        if (!sha || !Number.isFinite(ts) || ts < since) continue;
        const own = /^(commit|cherry-pick|revert)\b/.test(subject) || /^merge .*: Merge made by/.test(subject);
        if (!own) continue;
        if ((await git(wt, ['merge-base', '--is-ancestor', sha, 'HEAD'])).exitCode !== 0) continue;
        await addCommit(sha);
      }
      return out;
    }
  }
  const revs = await git(wt, ['rev-list', '--no-merges', `${input.startSha}..HEAD`]);
  for (const c of lines(revs.stdout)) await addCommit(c);
  return out;
}

/** Out-of-scope paths that are uncommitted (the ones a skipped discard leaves behind). */
export async function uncommittedOutOfScope(input: GuardInput): Promise<string[]> {
  return outOfScope(input, await dirtyPaths(input.worktree));
}

/**
 * Throws away the shift's own out-of-scope changes (uncommitted edits, untracked files and out-of-scope edits it
 * committed since `startSha`) so that the shift-end autocommit never commits them. Never reverts content that arrived
 * through a main or base-branch merge or that another process put on the branch, and does nothing when HEAD left the
 * shift's history (a reset, rebase or rewrite).
 */
export async function discardOutOfScope(input: GuardInput): Promise<DiscardResult> {
  const result: DiscardResult = { discarded: [], kept: [] };
  if (!effectiveWritableGlobs(input)) return result;
  const head = (await git(input.worktree, ['rev-parse', 'HEAD'])).stdout.trim();
  if (
    head !== input.startSha &&
    (await git(input.worktree, ['merge-base', '--is-ancestor', input.startSha, 'HEAD'])).exitCode !== 0
  ) {
    result.skipped = { reason: 'head_moved', from: input.startSha, to: head };
    return result;
  }
  const opts = exemptOpts(input);
  const bad = outOfScope(input, await changedPaths(input.worktree, input.startSha, opts));
  if (bad.length === 0) return result;
  const ex = await mergeExemptions(input.worktree, input.startSha, opts);
  const own = new Set([...(await dirtyPaths(input.worktree)), ...(await ownCommitPaths(input))]);
  for (const p of bad) {
    if (!own.has(p)) {
      result.kept.push(p);
      continue;
    }
    const from = ex.restoreFrom.get(p) ?? input.startSha;
    const there = await git(input.worktree, ['cat-file', '-e', `${from}:${p}`]);
    if (there.exitCode === 0) {
      await git(input.worktree, ['checkout', from, '--', p]);
    } else {
      await git(input.worktree, ['rm', '-rf', '--cached', '--ignore-unmatch', '--', p]);
      await git(input.worktree, ['clean', '-fdq', '--', p]);
    }
    result.discarded.push(p);
  }
  return result;
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
  const changed = await changedPaths(input.worktree, input.startSha, exemptOpts(input));

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
        detail: `${input.roleKey === 'writer' ? 'Writers may only change documentation' : input.roleKey === 'architect' ? 'The architect may only change documentation and its report (never product code or tests, except merge conflicts of the main or base branch)' : 'This role may only change paths matching'} (${effectiveWritableGlobs(input)?.join(', ') || 'nothing'}); changed: ${bad.slice(0, 10).join(', ')}`,
      });
    }
  }

  // Builders never do E2E testing: the tester owns the E2E paths (spec "Testing strategy").
  if (input.roleKey === 'builder' && input.e2eGlobs.length > 0) {
    const isE2e = picomatch(input.e2eGlobs, { dot: true });
    const touched = await netChangedFromBase(
      input.worktree,
      input.baseBranch,
      changed.filter((p) => isE2e(p)),
    );
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
    if (isRunnerOwnedBranch(b)) continue;
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
