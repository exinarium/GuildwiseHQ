import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { excludeStubs, sandboxStubNoise, statusLinesWithoutStubs } from '../adapters/sandbox-placeholders.ts';
import { git } from '../git/git.ts';
import { installDirsOf, withInstallOutputIgnored } from '../git/install-output.ts';

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
/** devops-box-access: a leftovers commit that adds more files than this is refused (an unknown installer's output, in bulk). */
export const AUTOCOMMIT_MAX_ADDED_FILES = 1000;

export type AutoCommitRefusalReason =
  | 'mass_deletion'
  | 'tree_revert'
  /** devops-box-access: it would add to or change install output already committed on the branch. */
  | 'install_output'
  /** devops-box-access: it would add a nested repository (a gitlink that `.gitmodules` does not list). */
  | 'embedded_repo'
  /** devops-box-access: it would add more than `AUTOCOMMIT_MAX_ADDED_FILES` files. */
  | 'mass_addition';

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
  /** install_output, embedded_repo, mass_addition: the paths concerned (install folders, nested repos, added files), at most 30. */
  paths?: string[];
  /** mass_addition: the top-level folders of the added files with their counts, largest first, at most 10. */
  addedByFolder?: Array<{ folder: string; count: number }>;
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
  /** The added paths (for the mass-addition note). */
  addedPaths: string[];
  /** Install folders the change adds to or changes (a deletion there is a clean-up and never counts). */
  installDirs: string[];
  /** New gitlinks that `.gitmodules` does not list. */
  embeddedRepos: string[];
}

/**
 * At most this many `venv` folders are checked for a `pyvenv.cfg` per commit. Past the cap a `venv` folder counts as NOT install
 * output (fails open, on purpose: bounded work per commit); bulk additions there still hit `mass_addition`.
 */
const MAX_VENV_CHECKS = 50;

/**
 * Looks at what `git add -A` would commit without touching the real index: on a temporary copy of it. Null when git
 * failed (the caller does not commit blind).
 */
async function inspectPending(
  worktree: string,
  pathspec: string[],
  env: Record<string, string>,
  gitPrefix: string[],
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
    if ((await git(worktree, [...gitPrefix, 'add', '-A', ...pathspec], { env: idxEnv })).exitCode !== 0)
      return null;
    const wt = await git(worktree, ['write-tree'], { env: idxEnv });
    const headTree = await git(worktree, ['rev-parse', 'HEAD^{tree}']);
    if (wt.exitCode !== 0 || headTree.exitCode !== 0) return null;
    // devops-box-access: --raw keeps the modes (a new gitlink is 160000) and both paths of a rename or copy
    const diff = await git(worktree, ['diff', '--cached', '-M', '--raw', '-z', 'HEAD'], { env: idxEnv });
    const ls = await git(worktree, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
    if (diff.exitCode !== 0 || ls.exitCode !== 0) return null;
    const tree = wt.stdout.trim();
    const deleted: string[] = [];
    const addedPaths: string[] = [];
    let modified = 0;
    const changed: string[] = [];
    const newLinks: string[] = [];
    // -z --raw: ":<src mode> <dst mode> <src sha> <dst sha> <status>" NUL path NUL (renames and copies: src NUL dst NUL)
    const parts = diff.stdout.split('\0');
    for (let i = 0; i < parts.length; ) {
      const head = parts[i++] ?? '';
      if (!head.startsWith(':')) continue;
      const fields = head.slice(1).split(' ');
      const dstMode = fields[1] ?? '';
      const status = fields[4] ?? '';
      const k = status[0];
      if (k === 'R' || k === 'C') {
        i++;
        changed.push(parts[i++] ?? '');
        continue;
      }
      const path = parts[i++] ?? '';
      if (k === 'D') deleted.push(path);
      else if (k === 'A') {
        addedPaths.push(path);
        changed.push(path);
        if (dstMode === '160000') newLinks.push(path);
      } else if (k === 'M' || k === 'T') {
        modified++;
        changed.push(path);
      }
    }
    const tracked = ls.stdout.split('\0').filter(Boolean).length;
    // tracked install output the change adds to or changes; a `venv` folder only when it is a virtualenv (pyvenv.cfg)
    const venv = new Map<string, boolean>();
    const isVirtualenv = async (d: string): Promise<boolean> => {
      const known = venv.get(d);
      if (known !== undefined) return known;
      if (venv.size >= MAX_VENV_CHECKS) return false;
      let yes = false;
      for (const t of [headTree.stdout.trim(), tree])
        if ((await git(worktree, ['cat-file', '-e', `${t}:${d}/pyvenv.cfg`])).exitCode === 0) yes = true;
      venv.set(d, yes);
      return yes;
    };
    const installDirs = new Set<string>();
    for (const path of changed)
      for (const c of installDirsOf(path))
        if (c.name !== 'venv' || (await isVirtualenv(c.dir))) {
          installDirs.add(c.dir);
          break;
        }
    // new gitlinks that are not submodules listed in the worktree's .gitmodules
    let embeddedRepos: string[] = [];
    if (newLinks.length) {
      const listed = new Set<string>();
      if (existsSync(join(worktree, '.gitmodules'))) {
        const m = await git(worktree, [
          'config',
          '-f',
          '.gitmodules',
          '--get-regexp',
          '^submodule\\..*\\.path$',
        ]);
        for (const line of m.stdout.split('\n')) {
          const sp = line.indexOf(' ');
          if (sp > 0)
            listed.add(
              line
                .slice(sp + 1)
                .trim()
                .replace(/^\.\//, '')
                .replace(/\/+$/, ''),
            );
        }
      }
      embeddedRepos = newLinks.filter((l) => !listed.has(l));
    }
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
      added: addedPaths.length,
      modified,
      addedPaths,
      installDirs: [...installDirs],
      embeddedRepos,
      ...(revertsTo ? { revertsTo } : {}),
    };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The top-level folders of `paths` with their counts, largest first (a file at the top counts as `.`). */
function byTopFolder(paths: string[], max: number): Array<{ folder: string; count: number }> {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const slash = p.indexOf('/');
    const top = slash > 0 ? `${p.slice(0, slash)}/` : '.';
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([folder, count]) => ({ folder, count }));
}

/**
 * Commits leftovers as `[<ticket>: ]Work in progress`: plain words, no agent, card or shift reference. It refuses (and
 * changes nothing: no add, reset, checkout or clean on the real index or tree) when the commit would delete a mass of
 * tracked files, restore the tree of an earlier commit, change committed install output, add a nested repository or add a
 * mass of files. devops-box-access: every git call that looks at or adds untracked files uses the runner's install-output
 * excludes (`withInstallOutputIgnored`), so node_modules, .venv, target and the like are never committed, even without a
 * .gitignore.
 */
export async function autoCommit(input: AutoCommitInput): Promise<AutoCommitResult> {
  // A merge of the main branch waiting for its conflicts to be resolved must not be committed half done (that would
  // record the conflict markers as the resolution): the next architect shift picks it up.
  if ((await git(input.worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).exitCode === 0)
    return { committed: false, skipped: 'merge_pending' };
  return withInstallOutputIgnored(input.worktree, (prefix) => commitLeftovers(input, prefix), input.env);
}

async function commitLeftovers(input: AutoCommitInput, prefix: string[]): Promise<AutoCommitResult> {
  // The sandbox's empty mount stubs (.gitmodules, .bashrc, ...) are never work: not committed, not a reason to commit.
  const status = await statusLinesWithoutStubs(input.worktree, { gitPrefix: prefix });
  if (!status.ok || status.lines.length === 0) return { committed: false, skipped: 'clean' };
  // Untracked stubs are not added, and a placeholder an earlier commit put on the branch is not deleted by this one:
  // its disappearance is the sandbox's doing, never a revert of the earlier commit (uat-runner-fixes-3 finding 4).
  const stubs = await sandboxStubNoise(input.worktree);
  const pathspec = ['--', '.', ...excludeStubs(stubs)];
  const hasHead =
    (await git(input.worktree, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])).exitCode === 0;
  if (hasHead) {
    const p = await inspectPending(input.worktree, pathspec, input.env, prefix);
    if (!p) return { committed: false, skipped: 'git_failed' };
    if (p.tree === p.headTree) return { committed: false, skipped: 'clean' };
    const massDeletion =
      p.deleted.length > AUTOCOMMIT_MAX_DELETED_FILES ||
      (p.deleted.length >= AUTOCOMMIT_PERCENT_MIN_FILES &&
        p.deleted.length * 100 > AUTOCOMMIT_MAX_DELETED_PERCENT * p.tracked);
    const reason: AutoCommitRefusalReason | null = p.revertsTo
      ? 'tree_revert'
      : massDeletion
        ? 'mass_deletion'
        : p.installDirs.length
          ? 'install_output'
          : p.embeddedRepos.length
            ? 'embedded_repo'
            : p.added > AUTOCOMMIT_MAX_ADDED_FILES
              ? 'mass_addition'
              : null;
    if (reason) {
      const paths =
        reason === 'install_output'
          ? p.installDirs
          : reason === 'embedded_repo'
            ? p.embeddedRepos
            : reason === 'mass_addition'
              ? p.addedPaths
              : null;
      return {
        committed: false,
        refused: {
          reason,
          deleted: p.deleted.length,
          tracked: p.tracked,
          added: p.added,
          modified: p.modified,
          deletedPaths: p.deleted.slice(0, MAX_LISTED),
          tree: p.tree,
          ...(p.revertsTo ? { revertsTo: p.revertsTo } : {}),
          ...(paths ? { paths: paths.slice(0, MAX_LISTED) } : {}),
          ...(reason === 'mass_addition' ? { addedByFolder: byTopFolder(p.addedPaths, 10) } : {}),
        },
      };
    }
  }
  const add = await git(input.worktree, [...prefix, 'add', '-A', ...pathspec], { env: input.env });
  if (add.exitCode !== 0) return { committed: false, skipped: 'git_failed' };
  const msg = input.ticket ? `${input.ticket}: Work in progress` : 'Work in progress';
  const c = await git(input.worktree, [...prefix, 'commit', '--no-verify', '-m', msg], { env: input.env });
  if (c.exitCode !== 0) return { committed: false, skipped: 'git_failed' };
  const head = await git(input.worktree, ['rev-parse', 'HEAD']);
  return { committed: true, sha: head.stdout.trim() };
}

/** Why a leftovers commit was refused, in one phrase. */
export function describeRefusal(r: AutoCommitRefusal): string {
  const listed = (r.paths ?? []).slice(0, 5).join(', ');
  switch (r.reason) {
    case 'tree_revert':
      return `its tree equals the tree of the earlier commit ${(r.revertsTo ?? '').slice(0, 7)} (it would undo the commits after it); it deletes ${r.deleted} tracked files`;
    case 'install_output':
      return `it would add to or change install output that is already committed on this branch (${listed})`;
    case 'embedded_repo':
      return `it would commit a cloned repository as a broken link (${listed})`;
    case 'mass_addition':
      return `it adds ${r.added} files (the limit is ${AUTOCOMMIT_MAX_ADDED_FILES})`;
    default:
      return `it deletes ${r.deleted} of ${r.tracked} tracked files (the limit is ${AUTOCOMMIT_MAX_DELETED_FILES} files, or ${AUTOCOMMIT_MAX_DELETED_PERCENT}% of the tracked files from ${AUTOCOMMIT_PERCENT_MIN_FILES} files on)`;
  }
}

/** What to do about a refused leftovers commit, per reason (the deletion advice only where files are deleted). */
export function refusalAdvice(r: AutoCommitRefusal): string {
  switch (r.reason) {
    case 'install_output': {
      const dirs = r.paths?.length ? r.paths : ['node_modules'];
      return `Install output is committed on this branch: run \`git rm -r --cached ${dirs.slice(0, 3).join(' ')}\` and commit that, or add an ignore rule.`;
    }
    case 'embedded_repo':
      return `A cloned repository (${(r.paths ?? []).map((p) => `\`${p}\``).join(', ')}) would be committed as a broken link: remove it or add it as a submodule.`;
    case 'mass_addition':
      return 'If this is install output, add an ignore rule or delete it; if it is real work, commit it yourself with a message that says why.';
    default:
      return 'If the deletion is intended, commit it yourself with a message that says why; if not, restore the files from HEAD.';
  }
}

/** The card note for a refused leftovers commit. */
export function autoCommitRefusedNote(
  r: AutoCommitRefusal,
  opts: { shiftId: string; branch?: string; where: 'shift_end' | 'report' },
): string {
  const head = `The runner did not commit the leftovers of shift ${opts.shiftId}${opts.branch ? ` on ${opts.branch}` : ''} as "Work in progress"${opts.where === 'report' ? ' (when the report was made)' : ''}: ${describeRefusal(r)}.`;
  const kept = 'Nothing was reset, restored or deleted: the changes are still uncommitted in the worktree.';
  const again = 'Until then every shift end in this worktree refuses again.';
  if (r.reason === 'mass_deletion' || r.reason === 'tree_revert') {
    const listed = r.deletedPaths.slice(0, MAX_LISTED).map((f) => `- \`${f}\``);
    if (r.deleted > listed.length) listed.push(`- ... and ${r.deleted - listed.length} more`);
    return [
      head,
      ...(r.deleted > 0 ? [`Deleted files (${r.deleted}):`, ...listed] : []),
      kept,
      `Before the next shift, check them: if they are intended, commit them with a message that says why; if not, restore the files from HEAD. ${again}`,
    ].join('\n');
  }
  if (r.reason === 'mass_addition') {
    const folders = (r.addedByFolder ?? []).map((f) => `- \`${f.folder}\` (${f.count})`);
    return [head, `Added files by folder:`, ...folders, kept, `${refusalAdvice(r)} ${again}`].join('\n');
  }
  const listed = (r.paths ?? []).map((f) => `- \`${f}\``);
  return [head, ...listed, kept, `${refusalAdvice(r)} ${again}`].join('\n');
}

/** Files `git status` shows as changed or untracked in the worktree (porcelain lines), empty when clean; install output left out. */
export async function uncommittedFiles(worktree: string): Promise<string[]> {
  const status = await withInstallOutputIgnored(worktree, (gitPrefix) =>
    statusLinesWithoutStubs(worktree, { gitPrefix }),
  );
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
