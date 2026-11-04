import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusLinesWithoutStubs, untrackedSandboxStubs } from '../adapters/sandbox-placeholders.ts';
import { git } from '../git/git.ts';

export interface AutoCommitInput {
  worktree: string;
  /** The ticket key the card came from (`DCPL-4276`), when it has one: the only reference that may appear in the message. */
  ticket?: string | null;
  /** The resolved commit identity (project setting, repository, workstation), as git author and committer variables. */
  env: Record<string, string>;
}

/** A leftovers commit that deletes more tracked files than this is refused (the GWP-63 stray commits deleted 86). */
export const AUTOCOMMIT_MAX_DELETED_FILES = 25;
/** ... or that deletes more than this percentage of the files tracked at HEAD ... */
export const AUTOCOMMIT_MAX_DELETED_PERCENT = 10;
/** ... the percentage rule applies only from this many deleted files, so a small repository can still lose a file or two. */
export const AUTOCOMMIT_PERCENT_MIN_FILES = 5;
/** How many commits behind HEAD (all parents) the tree-revert check compares against. */
export const AUTOCOMMIT_TREE_REVERT_DEPTH = 1000;

export type AutoCommitRefusalReason = 'mass_deletion' | 'tree_revert';

export interface AutoCommitRefusal {
  reason: AutoCommitRefusalReason;
  /** Tracked files the pending change removes (renames not counted). */
  deleted: number;
  /** Files tracked at HEAD. */
  tracked: number;
  added: number;
  modified: number;
  /** The deleted paths, at most 30, for the note. */
  deletedPaths: string[];
  /** The tree the commit would have had. */
  tree: string;
  /** tree_revert: the earlier commit whose tree that is. */
  revertsTo?: string;
}

export type AutoCommitResult =
  | { committed: true; sha: string; refused?: undefined; skipped?: undefined }
  | { committed: false; skipped: 'clean' | 'merge_pending' | 'git_failed'; refused?: undefined }
  | { committed: false; refused: AutoCommitRefusal; skipped?: undefined };

const MAX_LISTED = 30;

interface Pending {
  tree: string;
  headTree: string;
  tracked: number;
  deleted: string[];
  added: number;
  modified: number;
  revertsTo?: string;
}

/**
 * Looks at what `git add -A` would commit without touching the real index: on a temporary copy of it. Null when git
 * failed (the caller does not commit blind).
 */
async function inspectPending(
  worktree: string,
  pathspec: string[],
  env: Record<string, string>,
): Promise<Pending | null> {
  const dir = await mkdtemp(join(tmpdir(), 'aom-autocommit-'));
  try {
    const tmpIdx = join(dir, 'index');
    const idxEnv = { ...env, GIT_INDEX_FILE: tmpIdx };
    const idx = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    if (idx.exitCode !== 0) return null;
    const real = idx.stdout.trim();
    if (real && existsSync(real)) await copyFile(real, tmpIdx);
    else if ((await git(worktree, ['read-tree', 'HEAD'], { env: idxEnv })).exitCode !== 0) return null;
    if ((await git(worktree, ['add', '-A', ...pathspec], { env: idxEnv })).exitCode !== 0) return null;
    const wt = await git(worktree, ['write-tree'], { env: idxEnv });
    const headTree = await git(worktree, ['rev-parse', 'HEAD^{tree}']);
    if (wt.exitCode !== 0 || headTree.exitCode !== 0) return null;
    const diff = await git(worktree, ['diff', '--cached', '-M', '--name-status', '-z', 'HEAD'], {
      env: idxEnv,
    });
    const ls = await git(worktree, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
    if (diff.exitCode !== 0 || ls.exitCode !== 0) return null;
    const tree = wt.stdout.trim();
    const deleted: string[] = [];
    let added = 0;
    let modified = 0;
    // -z --name-status: STATUS NUL path NUL (renames and copies carry two paths)
    const parts = diff.stdout.split('\0');
    for (let i = 0; i < parts.length; ) {
      const status = parts[i++] ?? '';
      if (!status) continue;
      const k = status[0];
      if (k === 'R' || k === 'C') i += 2;
      else {
        const path = parts[i++] ?? '';
        if (k === 'D') deleted.push(path);
        else if (k === 'A') added++;
        else if (k === 'M' || k === 'T') modified++;
      }
    }
    const tracked = ls.stdout.split('\0').filter(Boolean).length;
    let revertsTo: string | undefined;
    if (tree !== headTree.stdout.trim()) {
      const log = await git(worktree, [
        'log',
        '--skip=1',
        '-n',
        String(AUTOCOMMIT_TREE_REVERT_DEPTH),
        '--format=%H %T',
        'HEAD',
      ]);
      if (log.exitCode !== 0) return null;
      for (const line of log.stdout.split('\n')) {
        const [sha, t] = line.trim().split(' ');
        if (sha && t === tree) {
          revertsTo = sha;
          break;
        }
      }
    }
    return {
      tree,
      headTree: headTree.stdout.trim(),
      tracked,
      deleted,
      added,
      modified,
      ...(revertsTo ? { revertsTo } : {}),
    };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Commits leftovers as `[<ticket>: ]Work in progress`: plain words, no agent, card or shift reference. It refuses (and
 * changes nothing: no add, reset, checkout or clean on the real index or tree) when the commit would delete a mass of
 * tracked files or restore the tree of an earlier commit.
 */
export async function autoCommit(input: AutoCommitInput): Promise<AutoCommitResult> {
  // A merge of the main branch waiting for its conflicts to be resolved must not be committed half done (that would
  // record the conflict markers as the resolution): the next architect shift picks it up.
  if ((await git(input.worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).exitCode === 0)
    return { committed: false, skipped: 'merge_pending' };
  // The sandbox's empty mount stubs (.gitmodules, .bashrc, ...) are never work: not committed, not a reason to commit.
  const status = await statusLinesWithoutStubs(input.worktree);
  if (!status.ok || status.lines.length === 0) return { committed: false, skipped: 'clean' };
  const stubs = await untrackedSandboxStubs(input.worktree);
  const pathspec = ['--', '.', ...stubs.map((n) => `:(exclude,top)${n}`)];
  const hasHead =
    (await git(input.worktree, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])).exitCode === 0;
  if (hasHead) {
    const p = await inspectPending(input.worktree, pathspec, input.env);
    if (!p) return { committed: false, skipped: 'git_failed' };
    if (p.tree === p.headTree) return { committed: false, skipped: 'clean' };
    const massDeletion =
      p.deleted.length > AUTOCOMMIT_MAX_DELETED_FILES ||
      (p.deleted.length >= AUTOCOMMIT_PERCENT_MIN_FILES &&
        p.deleted.length * 100 > AUTOCOMMIT_MAX_DELETED_PERCENT * p.tracked);
    if (p.revertsTo || massDeletion) {
      return {
        committed: false,
        refused: {
          reason: p.revertsTo ? 'tree_revert' : 'mass_deletion',
          deleted: p.deleted.length,
          tracked: p.tracked,
          added: p.added,
          modified: p.modified,
          deletedPaths: p.deleted.slice(0, MAX_LISTED),
          tree: p.tree,
          ...(p.revertsTo ? { revertsTo: p.revertsTo } : {}),
        },
      };
    }
  }
  const add = await git(input.worktree, ['add', '-A', ...pathspec], { env: input.env });
  if (add.exitCode !== 0) return { committed: false, skipped: 'git_failed' };
  const msg = input.ticket ? `${input.ticket}: Work in progress` : 'Work in progress';
  const c = await git(input.worktree, ['commit', '--no-verify', '-m', msg], { env: input.env });
  if (c.exitCode !== 0) return { committed: false, skipped: 'git_failed' };
  const head = await git(input.worktree, ['rev-parse', 'HEAD']);
  return { committed: true, sha: head.stdout.trim() };
}

/** Why a leftovers commit was refused, in one phrase. */
export function describeRefusal(r: AutoCommitRefusal): string {
  if (r.reason === 'tree_revert')
    return `its tree equals the tree of the earlier commit ${(r.revertsTo ?? '').slice(0, 7)} (it would undo the commits after it); it deletes ${r.deleted} tracked files`;
  return `it deletes ${r.deleted} of ${r.tracked} tracked files (the limit is ${AUTOCOMMIT_MAX_DELETED_FILES} files, or ${AUTOCOMMIT_MAX_DELETED_PERCENT}% of the tracked files from ${AUTOCOMMIT_PERCENT_MIN_FILES} files on)`;
}

/** The card note for a refused leftovers commit. */
export function autoCommitRefusedNote(
  r: AutoCommitRefusal,
  opts: { shiftId: string; branch?: string; where: 'shift_end' | 'report' },
): string {
  const listed = r.deletedPaths.slice(0, MAX_LISTED).map((f) => `- \`${f}\``);
  if (r.deleted > listed.length) listed.push(`- ... and ${r.deleted - listed.length} more`);
  return [
    `The runner did not commit the leftovers of shift ${opts.shiftId}${opts.branch ? ` on ${opts.branch}` : ''} as "Work in progress"${opts.where === 'report' ? ' (when the report was made)' : ''}: ${describeRefusal(r)}.`,
    ...(r.deleted > 0 ? [`Deleted files (${r.deleted}):`, ...listed] : []),
    'Nothing was reset, restored or deleted: the changes are still uncommitted in the worktree.',
    'Before the next shift, check them: if they are intended, commit them with a message that says why; if not, restore the files from HEAD. Until then every shift end in this worktree refuses again.',
  ].join('\n');
}

/** Files `git status` shows as changed or untracked in the worktree (porcelain lines), empty when clean. */
export async function uncommittedFiles(worktree: string): Promise<string[]> {
  const status = await statusLinesWithoutStubs(worktree);
  return status.ok ? status.lines.map((l) => l.trimEnd()) : [];
}

/**
 * The card note for a shift that ended without a report but left work in the worktree: it lists the files so the next
 * shift (and the owner) can see where things stand. `committed` says whether the runner's leftovers commit kept them.
 */
export function unreportedWorkNote(
  files: string[],
  opts: { outcome: string; committed: boolean; refused?: boolean; sha?: string; branch?: string },
): string {
  const listed = files.slice(0, MAX_LISTED).map((f) => `- \`${f}\``);
  if (files.length > MAX_LISTED) listed.push(`- ... and ${files.length - MAX_LISTED} more`);
  const kept = opts.committed
    ? `The runner committed them as a leftovers commit${opts.sha ? ` (${opts.sha})` : ''}${opts.branch ? ` on ${opts.branch}` : ''}, so nothing is lost; the agent had not reported them as done.`
    : opts.refused
      ? 'They are still uncommitted in the worktree: the runner refused to commit them (see the note on the refused leftovers commit).'
      : 'They are still uncommitted in the worktree (a merge of the main branch is waiting to be resolved).';
  return [
    `The shift ended without a report (${opts.outcome}) with ${files.length} uncommitted file${files.length === 1 ? '' : 's'} in the worktree:`,
    ...listed,
    kept,
    'The next shift should check these files first: run the build and tests, then finish or fix them and report.',
  ].join('\n');
}
