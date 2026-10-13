import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HygieneRepoResult, looksLikeSecret, savedWorkBranch } from '@aom/shared';
import { git } from '../git/git.ts';

type Saved = NonNullable<HygieneRepoResult['savedWork']>;

/**
 * Local commits that were never on the remote are kept on a `guildwise/saved-work/<date>` branch (pointing at `tip`)
 * before the working branch is realigned to a rewritten remote. Only that branch is pushed, never the working branch.
 */
export async function saveCommitsBranch(
  cwd: string,
  tip: string,
  opts: { remote: boolean; now?: Date; log?: (cmd: string) => void },
): Promise<{ branch: string; pushed: boolean; error?: string }> {
  const now = opts.now ?? new Date();
  let branch = savedWorkBranch(now);
  for (
    let n = 2;
    (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0;
    n++
  )
    branch = savedWorkBranch(now, `-${n}`);
  opts.log?.(`git -C ${cwd} branch ${branch} ${tip.slice(0, 7)}`);
  const made = await git(cwd, ['branch', '--', branch, tip]);
  if (made.exitCode !== 0)
    return { branch: '', pushed: false, error: 'could not create the saved-work branch' };
  if (!opts.remote) return { branch, pushed: false };
  opts.log?.(`git -C ${cwd} push -u origin ${branch}`);
  const push = await git(cwd, ['push', '-u', 'origin', '--', branch]);
  return push.exitCode === 0
    ? { branch, pushed: true }
    : {
        branch,
        pushed: false,
        error: `saved on ${branch} here, but pushing it failed: ${(push.stderr || push.stdout).trim().split('\n')[0]}`,
      };
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
 * Stores the user's uncommitted edits on `guildwise/saved-work/<date>` without touching their checkout (owner decision
 * G-Q7): a throwaway index builds the tree, a commit on top of the current HEAD records it, and only that branch is
 * pushed. Files that look like secrets are skipped. Never forces, never discards, never touches the working branch.
 * Returns null when there is nothing safe to save or the same content is already saved.
 */
export async function saveUncommittedWork(
  cwd: string,
  opts: { remote: boolean; now?: Date; log?: (cmd: string) => void } = { remote: false },
): Promise<{ saved: Saved | null; error?: string }> {
  const all = await dirtyPaths(cwd);
  if (all.length === 0) return { saved: null };
  const skipped = all.filter(looksLikeSecret);
  const files = all.filter((f) => !looksLikeSecret(f));
  if (files.length === 0) return { saved: { branch: '', files: [], skipped, pushed: false } };

  const head = (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
  if (!head) return { saved: null, error: 'the repository has no commit yet' };
  const dir = await mkdtemp(join(tmpdir(), 'aom-saved-'));
  const env = {
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: 'Guildwise HQ (aom)',
    GIT_AUTHOR_EMAIL: 'aom@runner.aom.invalid',
    GIT_COMMITTER_NAME: 'Guildwise HQ (aom)',
    GIT_COMMITTER_EMAIL: 'aom@runner.aom.invalid',
  };
  try {
    if ((await git(cwd, ['read-tree', 'HEAD'], { env })).exitCode !== 0)
      return { saved: null, error: 'could not read the current commit' };
    // `-A` with an explicit pathspec records deletions too; the user's own index and files are not touched.
    const add = await git(cwd, ['add', '-A', '--', ...files], { env });
    if (add.exitCode !== 0) return { saved: null, error: add.stderr.trim() || 'git add failed' };
    const tree = (await git(cwd, ['write-tree'], { env })).stdout.trim();
    const headTree = (await git(cwd, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    if (!tree || tree === headTree)
      return { saved: skipped.length ? { branch: '', files: [], skipped, pushed: false } : null };

    // The same content is already saved on an earlier saved-work branch: do not pile up copies.
    const existing = await git(cwd, [
      'for-each-ref',
      '--format=%(refname:short) %(objectname)',
      'refs/heads/guildwise/saved-work',
    ]);
    for (const line of existing.stdout.split('\n').filter(Boolean)) {
      const [name, sha] = line.split(' ');
      const t = (await git(cwd, ['rev-parse', `${sha}^{tree}`])).stdout.trim();
      if (t === tree) return { saved: { branch: name as string, files, skipped, pushed: false } };
    }

    const now = opts.now ?? new Date();
    let branch = savedWorkBranch(now);
    for (
      let n = 2;
      (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).exitCode === 0;
      n++
    )
      branch = savedWorkBranch(now, `-${n}`);
    const msg = `chore: saved work (Guildwise HQ hygiene)\n\nUncommitted edits found in this checkout, stored here so nothing is lost.\n${files
      .slice(0, 20)
      .map((f) => `- ${f}`)
      .join('\n')}`;
    const commit = await git(cwd, ['commit-tree', tree, '-p', head, '-m', msg], { env });
    if (commit.exitCode !== 0)
      return { saved: null, error: commit.stderr.trim() || 'git commit-tree failed' };
    const sha = commit.stdout.trim();
    opts.log?.(`git -C ${cwd} update-ref refs/heads/${branch} ${sha.slice(0, 7)}`);
    if ((await git(cwd, ['update-ref', `refs/heads/${branch}`, sha])).exitCode !== 0)
      return { saved: null, error: 'could not create the saved-work branch' };

    let pushed = false;
    let error: string | undefined;
    if (opts.remote) {
      opts.log?.(`git -C ${cwd} push -u origin ${branch}`);
      const push = await git(cwd, ['push', '-u', 'origin', '--', branch]);
      pushed = push.exitCode === 0;
      if (!pushed)
        error = `saved on ${branch} here, but pushing it failed: ${(push.stderr || push.stdout).trim().split('\n')[0]}`;
    }
    return { saved: { branch, files, skipped, pushed }, ...(error ? { error } : {}) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
