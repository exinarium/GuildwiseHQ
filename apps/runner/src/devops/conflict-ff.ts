import { isSafeGitRef } from '@aom/shared';
import { statusLinesWithoutStubs } from '../adapters/sandbox-placeholders.ts';
import { type BranchLedger, ledgerRepoKey } from '../git/branch-ledger.ts';
import { type ConflictRecords, conflictRefSnapshot } from '../git/conflict-record.ts';
import { git } from '../git/git.ts';
import { hasRunnerPrefix, tidyUpRefusal } from './tidy-up-rules.ts';

/**
 * runner-authority-fixes T7: the DevOps engineer never moves a card branch or the working branch. It resolves a conflict
 * on a scratch branch (`conflict/<name>-a<n>`, in a scratch worktree, by merging the base into it); after its terminal
 * "Resolved:" report the runner moves the real branch FORWARD to that result itself, only when every check holds:
 *
 * - the runner recorded this conflict itself (conflict-record.ts) for this repository, branch and current head;
 * - a card branch is a runner card branch (its ledger or a runner-fixed prefix), never a protected one;
 * - exactly one `conflict/<name>-a*` branch was created or moved during this shift, and its tip descends from the head;
 * - a working-branch result (hygiene pushes it without review) has exactly two parents, the recorded head and the
 *   recorded `origin/<wb>`, and differs from git's own merge of the two only in the paths git reports as conflicted;
 * - the move: checked out and clean, `merge --ff-only`; checked out but dirty, no move; not checked out, `update-ref`
 *   with the old value.
 *
 * Bound: a compromised server can at most move a branch forward onto a conflict the runner recorded, with commits made in
 * this shift; a card then goes through review again. A script forging a record is the D1 leftover.
 */

export type ConflictTarget =
  | { kind: 'card'; repoPath: string; branch: string; ref: string }
  | { kind: 'working'; repoPath: string; branch: string };

export type ConflictRefSnapshot = Map<string, string>;

const SHA = /^[0-9a-f]{40,64}$/;

/** The scratch branch prefix of a target (`conflict/<ref>-a`, `conflict/<wb with / as ->-a`). */
export const scratchPrefix = (t: ConflictTarget): string =>
  `refs/heads/conflict/${t.kind === 'card' ? t.ref : t.branch.replaceAll('/', '-')}-a`;

/** `refs/heads/conflict/*` -> sha (conflict-record.ts; the shift-start snapshot is only a fallback, Rework 1 B2). */
export { conflictRefSnapshot };

async function worktrees(repoPath: string): Promise<Array<{ path: string; branch: string | null }>> {
  const r = await git(repoPath, ['worktree', 'list', '--porcelain']);
  return r.stdout
    .split(/\n\n+/)
    .map((b) => ({
      path: /^worktree (.+)$/m.exec(b)?.[1] ?? '',
      branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] ?? null,
    }))
    .filter((w) => w.path);
}

/** git's own merge of `a` and `b`: its tree and the paths it reports as conflicted. */
async function gitMerge(
  repoPath: string,
  a: string,
  b: string,
): Promise<{ tree: string; conflicted: string[] } | null> {
  const r = await git(repoPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b]);
  if (r.exitCode !== 0 && r.exitCode !== 1) return null;
  const lines = r.stdout.split('\n');
  const tree = lines[0]?.trim() ?? '';
  if (!SHA.test(tree)) return null;
  const conflicted = lines
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  return { tree, conflicted: [...new Set(conflicted)] };
}

export interface ConflictResolution {
  moved: boolean;
  /** One plain sentence for the shift's progress and the log. */
  note: string;
  /** Working branch: the conflicted paths the resolution changed. */
  paths?: string[];
}

export async function applyConflictResolution(o: {
  target: ConflictTarget;
  /** The conflict refs when the shift started. */
  before: ConflictRefSnapshot;
  records: ConflictRecords | null;
  ledger?: BranchLedger;
}): Promise<ConflictResolution> {
  const t = o.target;
  const keep = (why: string): ConflictResolution => ({
    moved: false,
    note: `${t.branch} was not moved: ${why}`,
  });
  if (!isSafeGitRef(t.branch)) return keep('not a safe branch name');
  const repo = await ledgerRepoKey(t.repoPath);
  if (t.kind === 'card') {
    const refusal = tidyUpRefusal(t.branch, {});
    if (refusal) return keep(refusal);
    if (!hasRunnerPrefix(t.branch) && !o.ledger?.has(repo, t.branch))
      return keep('it is not a card branch of this runner');
  }
  const head = (
    await git(t.repoPath, ['rev-parse', '--verify', '-q', `refs/heads/${t.branch}`])
  ).stdout.trim();
  if (!SHA.test(head)) return keep('the branch does not exist in this clone');
  const record = o.records?.find(repo, t.branch, t.kind) ?? null;
  if (!record) return keep('this runner did not see a conflict on it');
  if (record.head !== head) return keep('it moved since the conflict was seen');

  // the refs as they were when the runner recorded the conflict (older records: the shift-start snapshot)
  const before: ConflictRefSnapshot = record.refs ? new Map(Object.entries(record.refs)) : o.before;
  const now = await conflictRefSnapshot(t.repoPath);
  const prefix = scratchPrefix(t);
  const candidates = [...now].filter(
    ([ref, sha]) =>
      ref.startsWith(prefix) && /^\d+$/.test(ref.slice(prefix.length)) && before.get(ref) !== sha,
  );
  if (candidates.length !== 1)
    return keep(
      candidates.length === 0
        ? `no ${prefix.slice('refs/heads/'.length)}<n> branch was made in this shift`
        : `more than one ${prefix.slice('refs/heads/'.length)}<n> branch was made in this shift`,
    );
  const [scratchRef, tip] = candidates[0] as [string, string];
  const scratch = scratchRef.slice('refs/heads/'.length);
  if (tip === head) return keep(`${scratch} holds no resolution`);
  if ((await git(t.repoPath, ['merge-base', '--is-ancestor', head, tip])).exitCode !== 0)
    return keep(`${scratch} does not build on ${t.branch} (merge the base into it, never rebase)`);

  let paths: string[] | undefined;
  if (t.kind === 'working') {
    const originHead = record.originHead;
    if (!originHead) return keep('the conflict record has no origin head');
    const parents = (await git(t.repoPath, ['rev-list', '--parents', '-n', '1', tip])).stdout
      .trim()
      .split(' ')
      .slice(1);
    if (parents.length !== 2 || !parents.includes(head) || !parents.includes(originHead))
      return keep(`${scratch} is not one merge of ${t.branch} and origin/${t.branch}`);
    const merged = await gitMerge(t.repoPath, head, originHead);
    if (!merged) return keep('git could not compute the merge to compare with');
    const diff = await git(t.repoPath, ['diff', '--name-only', '--no-renames', merged.tree, `${tip}^{tree}`]);
    if (diff.exitCode !== 0) return keep('the resolution could not be compared');
    const changed = diff.stdout.split('\n').filter(Boolean);
    const extra = changed.filter((p) => !merged.conflicted.includes(p));
    if (extra.length)
      return keep(
        `${scratch} also changes files that were not in conflict (${extra.slice(0, 5).join(', ')})`,
      );
    paths = changed;
  }

  // the move
  const wts = await worktrees(t.repoPath);
  const at = wts.find((w) => w.branch === t.branch);
  if (at) {
    const dirty = (await statusLinesWithoutStubs(at.path)).lines.join('\n').trim();
    if (dirty) return keep(`it is checked out in ${at.path} with uncommitted changes`);
    const ff = await git(at.path, ['merge', '--ff-only', tip]);
    if (ff.exitCode !== 0)
      return keep(`the fast-forward failed: ${(ff.stderr || ff.stdout).trim().split('\n')[0]}`);
  } else {
    const u = await git(t.repoPath, ['update-ref', `refs/heads/${t.branch}`, tip, head]);
    if (u.exitCode !== 0) return keep('it moved meanwhile');
  }
  o.records?.drop(repo, t.branch, t.kind);
  // the scratch branch and its worktree go (a worktree with changes stays, and so does its branch)
  const scratchWt = wts.find((w) => w.branch === scratch);
  const removed =
    !scratchWt || (await git(t.repoPath, ['worktree', 'remove', '--', scratchWt.path])).exitCode === 0;
  if (removed) await git(t.repoPath, ['branch', '-D', '--', scratch]);
  return {
    moved: true,
    note: `the runner moved ${t.branch} forward to the resolution on ${scratch} (${tip.slice(0, 10)})${paths ? `; resolved files: ${paths.join(', ') || '(none)'}` : ''}`,
    ...(paths ? { paths } : {}),
  };
}
