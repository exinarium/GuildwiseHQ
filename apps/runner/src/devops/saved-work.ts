import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HygieneRepoResult, looksLikeSecret } from '@aom/shared';
import { git, repoIdentity } from '../git/git.ts';

type Saved = NonNullable<HygieneRepoResult['savedWork']>;

/*
 * Saved work leaves NO trace of the product in the user's repository: no branch with a product name, nothing pushed.
 * Everything is a stash entry (`git stash list`) with a plain message ("saved work <ISO date>: ..."). A stash entry is a
 * commit W with parents [HEAD, I] (+ U for untracked files); `git stash apply` restores it, and `git branch <name>
 * stash@{n}^1` recovers a series of commits that a stash holds as W's first parent.
 */

/** Marks the stash entries hygiene made: "saved work 2026-10-13T10:00:00.000Z: ...". */
export const SAVED_WORK_RE = /saved work \d{4}-\d{2}-\d{2}T/;

const FALLBACK = { name: 'Repository hygiene', email: 'hygiene@localhost.invalid' };

async function identityEnv(cwd: string): Promise<Record<string, string>> {
  const id = await repoIdentity(cwd, FALLBACK);
  return {
    GIT_AUTHOR_NAME: id.name,
    GIT_AUTHOR_EMAIL: id.email,
    GIT_COMMITTER_NAME: id.name,
    GIT_COMMITTER_EMAIL: id.email,
  };
}

/** The stash entries as `{ sha, subject }`, newest first. */
async function stashEntries(cwd: string): Promise<Array<{ sha: string; subject: string }>> {
  const r = await git(cwd, ['stash', 'list', '--format=%H %gs']);
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ sha: l.slice(0, l.indexOf(' ')), subject: l.slice(l.indexOf(' ') + 1) }));
}

/** Does a stash entry already keep `tip` as its first parent (commits kept earlier)? */
async function stashKeeps(cwd: string, tip: string): Promise<boolean> {
  for (const e of await stashEntries(cwd)) {
    const p = (await git(cwd, ['rev-parse', '--verify', '--quiet', `${e.sha}^1`])).stdout.trim();
    if (p === tip) return true;
  }
  return false;
}

/**
 * Keeps a series of commits reachable without any ref name: a stash entry W (tree of `tip`, parents [tip, I]) whose
 * first parent is the tip. Recover with `git branch <name> stash@{n}^1`.
 */
export async function stashCommits(
  cwd: string,
  tip: string,
  message: string,
  opts: { log?: (cmd: string) => void } = {},
): Promise<{ ok: boolean; error?: string }> {
  const env = await identityEnv(cwd);
  const tree = (await git(cwd, ['rev-parse', `${tip}^{tree}`])).stdout.trim();
  if (!tree) return { ok: false, error: 'could not read the commits to keep' };
  const i = await git(cwd, ['commit-tree', tree, '-p', tip, '-m', 'index on saved work'], { env });
  if (i.exitCode !== 0) return { ok: false, error: i.stderr.trim() || 'git commit-tree failed' };
  const w = await git(cwd, ['commit-tree', tree, '-p', tip, '-p', i.stdout.trim(), '-m', message], { env });
  if (w.exitCode !== 0) return { ok: false, error: w.stderr.trim() || 'git commit-tree failed' };
  opts.log?.(`git -C ${cwd} stash store -m "${message}" ${w.stdout.trim().slice(0, 7)}`);
  const store = await git(cwd, ['stash', 'store', '-m', message, w.stdout.trim()], { env });
  return store.exitCode === 0
    ? { ok: true }
    : { ok: false, error: store.stderr.trim() || 'git stash store failed' };
}

/**
 * Local commits that were never on the remote are kept in a stash entry (see {@link stashCommits}) before the working
 * branch is realigned to a rewritten remote. Nothing is pushed and no branch is made.
 */
export async function saveCommitsStash(
  cwd: string,
  tip: string,
  opts: { count: number; branch: string; now?: Date; log?: (cmd: string) => void },
): Promise<{ stash: string; error?: string }> {
  if (await stashKeeps(cwd, tip)) return { stash: 'an earlier saved-work stash' };
  const now = opts.now ?? new Date();
  const message = `saved work ${now.toISOString()}: ${opts.count} local commit(s) of ${opts.branch} before it was realigned to origin; recover with: git branch <name> stash@{n}^1`;
  const r = await stashCommits(cwd, tip, message, opts);
  return r.ok ? { stash: message } : { stash: '', error: r.error ?? 'could not keep the commits' };
}

/**
 * Older runners kept saved work on `guildwise/saved-work/<date>` branches (some pushed). Those carry the product's name
 * into the repository, so: each local branch is stored as a stash entry and deleted; each one on origin is fetched,
 * kept locally the same way (unless a stash or another branch already holds its commits) and deleted from origin. Only
 * that exact prefix is touched. Returns the actions to report.
 */
const OLD_PREFIX = 'guildwise/saved-work/';

export async function migrateSavedWorkBranches(
  cwd: string,
  opts: { remote: boolean; log?: (cmd: string) => void },
): Promise<{ actions: string[]; errors: string[] }> {
  const actions: string[] = [];
  const errors: string[] = [];
  const keep = async (name: string, tip: string, where: string): Promise<boolean> => {
    if (await stashKeeps(cwd, tip)) return true;
    const count =
      Number(
        (
          await git(cwd, [
            'rev-list',
            '--count',
            tip,
            '--not',
            '--exclude=refs/remotes/origin/guildwise/saved-work/*',
            '--remotes',
            '--exclude=refs/heads/guildwise/saved-work/*',
            '--branches',
          ])
        ).stdout.trim(),
      ) || 0;
    const message = `saved work ${new Date().toISOString()}: ${count} commit(s) from the former branch ${name} (${where}); recover with: git branch <name> stash@{n}^1`;
    const r = await stashCommits(cwd, tip, message, opts);
    if (!r.ok) errors.push(`could not keep ${name}: ${r.error}`);
    return r.ok;
  };

  const local = await git(cwd, [
    'for-each-ref',
    '--format=%(refname:short) %(objectname)',
    `refs/heads/${OLD_PREFIX}`,
  ]);
  for (const line of local.stdout.split('\n').filter(Boolean)) {
    const [name, tip] = line.split(' ') as [string, string];
    if (!name.startsWith(OLD_PREFIX)) continue;
    if (!(await keep(name, tip, 'local'))) continue;
    opts.log?.(`git -C ${cwd} branch -D ${name}`);
    if ((await git(cwd, ['branch', '-D', '--', name])).exitCode === 0)
      actions.push(`moved the old saved-work branch ${name} into a stash and removed the branch`);
  }

  if (opts.remote) {
    const remoteRefs = await git(cwd, [
      'for-each-ref',
      '--format=%(refname:short) %(objectname)',
      `refs/remotes/origin/${OLD_PREFIX}`,
    ]);
    for (const line of remoteRefs.stdout.split('\n').filter(Boolean)) {
      const [short, tip] = line.split(' ') as [string, string];
      const name = short.replace(/^origin\//, '');
      if (!name.startsWith(OLD_PREFIX)) continue;
      if (!(await keep(name, tip, 'from origin'))) continue;
      opts.log?.(`git -C ${cwd} push origin --delete ${name}`);
      const del = await git(cwd, ['push', 'origin', '--delete', '--', name]);
      if (del.exitCode === 0) {
        await git(cwd, ['update-ref', '-d', `refs/remotes/origin/${name}`]);
        actions.push(`kept the commits of origin/${name} in a stash and removed that branch from origin`);
      } else
        errors.push(
          `could not remove ${name} from origin: ${(del.stderr || del.stdout).trim().split('\n')[0]}`,
        );
    }
  }
  return { actions, errors };
}

/** Paths with changes (modified, deleted, untracked) from `git status --porcelain -z`; renames name both paths. */
export async function dirtyPaths(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
  if (r.exitCode !== 0) return [];
  const parts = r.stdout.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i] as string;
    const code = e.slice(0, 2);
    out.push(e.slice(3));
    if (code.includes('R') || code.includes('C')) {
      const from = parts[++i];
      if (from) out.push(from);
    }
  }
  return [...new Set(out)];
}

/**
 * Stores the user's uncommitted edits (also untracked files) as a stash entry, without touching their checkout, index
 * or working branch (owner decision G-Q7, revised: never pushed, no branch). Throwaway indexes build the trees; the
 * entry is shaped like `git stash`'s own (W commit with parents HEAD, I and, for untracked files, U), so
 * `git stash list/show/apply` work. Files that look like secrets are skipped. Returns null when there is nothing safe
 * to save; when the newest saved-work stash holds the same content, that entry is reported and no new one is made.
 */
export async function saveUncommittedWork(
  cwd: string,
  opts: { now?: Date; log?: (cmd: string) => void } = {},
): Promise<{ saved: Saved | null; error?: string }> {
  const all = await dirtyPaths(cwd);
  if (all.length === 0) return { saved: null };
  const skipped = all.filter(looksLikeSecret);
  const files = all.filter((f) => !looksLikeSecret(f));
  if (files.length === 0) return { saved: { branch: '', files: [], skipped, pushed: false } };

  const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  if (!head) return { saved: null, error: 'the repository has no commit yet' };
  const untrackedAll = new Set(
    (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean),
  );
  const untracked = files.filter((f) => untrackedAll.has(f));
  const tracked = files.filter((f) => !untrackedAll.has(f));
  const dir = await mkdtemp(join(tmpdir(), 'saved-'));
  const ident = await identityEnv(cwd);
  const env = { GIT_INDEX_FILE: join(dir, 'index'), ...ident };
  const envU = { GIT_INDEX_FILE: join(dir, 'index-untracked'), ...ident };
  try {
    if ((await git(cwd, ['read-tree', 'HEAD'], { env })).exitCode !== 0)
      return { saved: null, error: 'could not read the current commit' };
    // `-A` with an explicit pathspec records deletions too; the user's own index and files are not touched.
    if (tracked.length > 0) {
      const add = await git(cwd, ['add', '-A', '--', ...tracked], { env });
      if (add.exitCode !== 0) return { saved: null, error: add.stderr.trim() || 'git add failed' };
    }
    const wTree = (await git(cwd, ['write-tree'], { env })).stdout.trim();
    const headTree = (await git(cwd, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    let uTree = '';
    if (untracked.length > 0) {
      const add = await git(cwd, ['add', '--', ...untracked], { env: envU });
      if (add.exitCode !== 0) return { saved: null, error: add.stderr.trim() || 'git add failed' };
      uTree = (await git(cwd, ['write-tree'], { env: envU })).stdout.trim();
    }
    if (!wTree || (wTree === headTree && !uTree))
      return { saved: skipped.length ? { branch: '', files: [], skipped, pushed: false } : null };

    // The newest saved-work stash holds the same content: do not pile up copies.
    for (const e of await stashEntries(cwd)) {
      if (!SAVED_WORK_RE.test(e.subject)) continue;
      const t = (await git(cwd, ['rev-parse', `${e.sha}^{tree}`])).stdout.trim();
      const u = (await git(cwd, ['rev-parse', '--verify', '--quiet', `${e.sha}^3^{tree}`])).stdout.trim();
      if (t === wTree && u === uTree) {
        const m = SAVED_WORK_RE.exec(e.subject);
        return {
          saved: { branch: '', stash: e.subject.slice(m?.index ?? 0), files, skipped, pushed: false },
        };
      }
      break;
    }

    const now = opts.now ?? new Date();
    const message = `saved work ${now.toISOString()}: ${files.length} file(s) not committed`;
    const headLine = (await git(cwd, ['log', '-1', '--format=%h %s', head])).stdout.trim();
    const branchName = (await git(cwd, ['branch', '--show-current'])).stdout.trim() || '(no branch)';
    const commit = async (tree: string, parents: string[], msg: string) => {
      const r = await git(cwd, ['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', msg], {
        env,
      });
      return r.exitCode === 0 ? r.stdout.trim() : '';
    };
    const iCommit = await commit(headTree, [head], `index on ${branchName}: ${headLine}`);
    const uCommit = uTree ? await commit(uTree, [], `untracked files on ${branchName}: ${headLine}`) : '';
    const wCommit =
      iCommit &&
      (await commit(
        wTree,
        [head, iCommit, ...(uCommit ? [uCommit] : [])],
        `On ${branchName}: ${message}`,
      ));
    if (!wCommit || (uTree && !uCommit)) return { saved: null, error: 'git commit-tree failed' };
    opts.log?.(`git -C ${cwd} stash store -m "${message}" ${wCommit.slice(0, 7)}`);
    const store = await git(cwd, ['stash', 'store', '-m', message, wCommit], { env: ident });
    if (store.exitCode !== 0)
      return { saved: null, error: store.stderr.trim() || 'git stash store failed' };
    return { saved: { branch: '', stash: message, files, skipped, pushed: false } };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
