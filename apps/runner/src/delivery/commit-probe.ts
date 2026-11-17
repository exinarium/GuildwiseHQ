import type { ServerToRunnerOf } from '@aom/shared';
import { maskText } from '@aom/shared';
import { git } from '../git/git.ts';

/**
 * `repo.commit.probe`: read one commit of a deploy repository from the clone on this workstation, for the server, which
 * holds no clones. Either the tip of `origin/<branch>` (after a fresh `git fetch origin <branch>`) or "does this commit
 * exist" for a full or abbreviated sha. It only fetches and reads; it never touches a worktree.
 */

export interface CommitProbeDeps {
  findRepo(remoteUrlNormalized: string): Promise<{ localPath: string } | undefined>;
}

export interface CommitProbeResult {
  requestId: string;
  ok: boolean;
  sha?: string;
  shortSha?: string;
  subject?: string;
  author?: string;
  committedAt?: string;
  error?: 'no_clone' | 'no_branch' | 'fetch_failed' | 'not_found' | 'ambiguous' | 'timeout';
  message?: string;
}

const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[^\s~^:?*[\\]+$/;
const firstLine = (s: string) => maskText((s.split('\n').find((l) => l.trim()) ?? '').trim()).slice(0, 300);

export async function probeCommit(
  deps: CommitProbeDeps,
  msg: ServerToRunnerOf<'repo.commit.probe'>,
): Promise<CommitProbeResult> {
  const fail = (error: NonNullable<CommitProbeResult['error']>, message: string): CommitProbeResult => ({
    requestId: msg.requestId,
    ok: false,
    error,
    message: message.slice(0, 500),
  });
  const repo = await deps.findRepo(msg.remoteUrlNormalized);
  if (!repo) return fail('no_clone', 'this workstation has no clone of the repository');
  const branch = msg.branch;
  if (branch !== null && !SAFE_BRANCH.test(branch))
    return fail('no_branch', `"${branch}" is not a branch name`);
  if (!msg.sha && !branch) return fail('no_branch', 'the repository names no working branch');
  const timeoutMs = Math.max(1000, Math.min(msg.deadlineMs - 1000, 20_000));
  const fetched = { done: false, error: '' };
  const fetchOnce = async (): Promise<boolean> => {
    if (fetched.done) return fetched.error === '';
    fetched.done = true;
    const r = await git(repo.localPath, branch ? ['fetch', 'origin', branch] : ['fetch', 'origin'], {
      timeoutMs,
    });
    if (r.exitCode !== 0) fetched.error = firstLine(r.stderr) || 'git fetch failed';
    return r.exitCode === 0;
  };

  let rev: string;
  if (msg.sha) {
    const resolveSha = () => git(repo.localPath, ['rev-parse', '--verify', `${msg.sha}^{commit}`]);
    let r = await resolveSha();
    if (r.exitCode !== 0 && !/ambiguous/i.test(r.stderr)) {
      // not in the clone yet: one fetch, then look again
      await fetchOnce();
      r = await resolveSha();
    }
    if (r.exitCode !== 0)
      return /ambiguous/i.test(r.stderr)
        ? fail('ambiguous', `${msg.sha} matches several commits`)
        : fetched.error
          ? fail(
              'fetch_failed',
              `commit ${msg.sha} is not in the clone and git fetch failed: ${fetched.error}`,
            )
          : fail('not_found', `commit ${msg.sha} is not in the repository`);
    rev = r.stdout.trim();
  } else {
    if (!(await fetchOnce())) return fail('fetch_failed', `git fetch failed: ${fetched.error}`);
    const r = await git(repo.localPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/origin/${branch}^{commit}`,
    ]);
    if (r.exitCode !== 0) return fail('no_branch', `the branch ${branch} is not on origin`);
    rev = r.stdout.trim();
  }
  const log = await git(repo.localPath, ['log', '-1', '--format=%H%x00%h%x00%s%x00%an%x00%cI', rev]);
  if (log.exitCode !== 0) return fail('not_found', `commit ${rev} could not be read`);
  const [sha, shortSha, subject, author, committedAt] = log.stdout.trim().split('\0');
  if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return fail('not_found', `commit ${rev} could not be read`);
  return {
    requestId: msg.requestId,
    ok: true,
    sha,
    shortSha: (shortSha ?? sha.slice(0, 7)).slice(0, 64),
    subject: maskText(subject ?? '').slice(0, 300),
    author: (author ?? '').slice(0, 200),
    ...(committedAt && !Number.isNaN(Date.parse(committedAt))
      ? { committedAt: new Date(committedAt).toISOString() }
      : {}),
  };
}
