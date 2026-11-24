import { isSafeGitRef } from '@aom/shared';
import { git, hasRemote, originAuth, type RemoteAuth } from './git.ts';
import { withRepoLock } from './repo-lock.ts';

/**
 * An empty repository (no commit anywhere: a bare repository just made on a server, a new project on a host that was not
 * initialised) cannot hold a card worktree: there is no branch to cut one from, and every shift was turned away with
 * `worktree_failed "working branch 'main' does not exist"` (uat-runner-fixes-3 finding 5). The runner detects it when the
 * repository is cloned and at `env.ensure`, and the owner can have the first commit made with one click
 * (`repo.initial_commit`): an empty commit on the working branch, pushed to origin, never forced.
 */

/** git's own empty tree: it exists in every repository without being written. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface RepoStartState {
  /** No commit in the clone and none on origin (origin answered with no branch at all). */
  empty: boolean;
  /** The working branch (as asked for, else origin's HEAD name, else the clone's HEAD name). */
  branch: string;
  /** Not empty, but the working branch is neither local nor on origin. */
  branchMissing: boolean;
  /** Origin's branches; null when origin could not be asked (offline, no credentials) or there is none. */
  remoteHeads: string[] | null;
}

async function localHasCommits(repo: string): Promise<boolean> {
  const r = await git(repo, [
    'for-each-ref',
    '--count=1',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ]);
  if (r.exitCode === 0 && r.stdout.trim()) return true;
  return (await git(repo, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])).exitCode === 0;
}

/** Origin's branch names, and the name its HEAD points at (an empty repository still names one). Null: unreachable. */
async function remoteHeads(
  repo: string,
  auth?: RemoteAuth,
): Promise<{ heads: string[]; head: string | null } | null> {
  if (!(await hasRemote(repo))) return null;
  const a = await originAuth(repo, auth);
  if (!a) return null;
  const r = await git(repo, [...a.args, 'ls-remote', '--symref', 'origin'], {
    env: a.env,
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) return null;
  const heads: string[] = [];
  let head: string | null = null;
  for (const line of r.stdout.split('\n')) {
    const sym = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    if (sym?.[1]) head = sym[1];
    const m = /^[0-9a-f]{40,64}\s+refs\/heads\/(\S+)$/.exec(line.trim());
    if (m?.[1]) heads.push(m[1]);
  }
  return { heads, head };
}

/** What a clone holds for starting work: empty, the working branch missing, or fine. */
export async function repoStartState(
  repo: string,
  workingBranch?: string | null,
  auth?: RemoteAuth,
): Promise<RepoStartState> {
  const local = await localHasCommits(repo);
  const remote = await remoteHeads(repo, auth);
  const clonedHead = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  const branch = workingBranch || remote?.head || clonedHead || 'main';
  const remoteEmpty = remote ? remote.heads.length === 0 : !(await hasRemote(repo));
  const empty = !local && remoteEmpty;
  let branchMissing = false;
  if (!empty && workingBranch) {
    const here =
      (await git(repo, ['rev-parse', '-q', '--verify', `refs/heads/${workingBranch}`])).exitCode === 0;
    const there = remote
      ? remote.heads.includes(workingBranch)
      : (await git(repo, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${workingBranch}`]))
          .exitCode === 0;
    branchMissing = !here && !there;
  }
  return { empty, branch, branchMissing, remoteHeads: remote?.heads ?? null };
}

/** The plain sentence for an empty repository (the card, the desk, the Development environment). */
export const emptyRepoDetail = (name: string, branch: string): string =>
  `${name} is empty: it has no commits yet, so no card can start there. Create the first commit on ${branch} (one click on the desk), or push one yourself.`;

export type InitialCommitResult =
  | { ok: true; sha: string; branch: string; pushed: boolean }
  | { ok: false; error: string };

/**
 * Makes the first commit of an empty repository: an empty commit on `branch` with the given identity, pushed to origin
 * (a plain push: never forced, so a branch that appeared meanwhile refuses it), then the clone is put on that branch.
 * Refuses when the clone or origin already has a commit.
 */
export async function makeInitialCommit(o: {
  repo: string;
  branch: string;
  identity: { name: string; email: string };
  auth?: RemoteAuth;
  message?: string;
}): Promise<InitialCommitResult> {
  if (!isSafeGitRef(o.branch)) return { ok: false, error: `'${o.branch}' is not a valid branch name` };
  return withRepoLock(o.repo, async () => {
    const state = await repoStartState(o.repo, o.branch, o.auth);
    if (!state.empty)
      return {
        ok: false,
        error:
          state.remoteHeads === null && (await hasRemote(o.repo))
            ? 'origin could not be reached to check that it is still empty, so nothing was done'
            : 'the repository is not empty any more (it has a commit now), so nothing was done',
      };
    const env = {
      GIT_AUTHOR_NAME: o.identity.name,
      GIT_AUTHOR_EMAIL: o.identity.email,
      GIT_COMMITTER_NAME: o.identity.name,
      GIT_COMMITTER_EMAIL: o.identity.email,
    };
    const c = await git(o.repo, ['commit-tree', EMPTY_TREE, '-m', o.message ?? 'Initial commit'], { env });
    const sha = c.stdout.trim();
    if (c.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha))
      return { ok: false, error: `git commit-tree failed: ${c.stderr.trim().slice(0, 300)}` };
    let pushed = false;
    if (await hasRemote(o.repo)) {
      const a = await originAuth(o.repo, o.auth);
      if (!a) return { ok: false, error: 'no credentials for origin, so nothing was pushed' };
      const p = await git(o.repo, [...a.args, 'push', 'origin', `${sha}:refs/heads/${o.branch}`], {
        env: a.env,
        timeoutMs: 120_000,
      });
      if (p.exitCode !== 0)
        return {
          ok: false,
          error: `could not push the first commit to origin (${(p.stderr || p.stdout).trim().slice(0, 300)}). Check that this workstation may push to the repository`,
        };
      pushed = true;
      await git(o.repo, [...a.args, 'fetch', 'origin', o.branch], { env: a.env, timeoutMs: 120_000 });
    }
    // the clone: the new branch, checked out (the tree is empty, so nothing on disk changes)
    await git(o.repo, ['update-ref', `refs/heads/${o.branch}`, sha, '']);
    if ((await git(o.repo, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])).exitCode !== 0) {
      await git(o.repo, ['symbolic-ref', 'HEAD', `refs/heads/${o.branch}`]);
      await git(o.repo, ['read-tree', 'HEAD']);
    }
    if (pushed) {
      await git(o.repo, ['branch', `--set-upstream-to=origin/${o.branch}`, o.branch]);
      await git(o.repo, ['remote', 'set-head', 'origin', o.branch]);
    }
    return { ok: true, sha, branch: o.branch, pushed };
  });
}
