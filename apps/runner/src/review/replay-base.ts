import { git, gitOk, revParse } from '../git/git.ts';
import { withRepoLock } from '../git/repo-lock.ts';
import type { GitAuth } from '../git/worktrees.ts';

/**
 * The diff base of an already merged pull request (20-PR replay): the merge base of the base branch tip at merge time
 * (the first parent of the merge commit) and the pull request head. That holds for merge, squash and rebase merges.
 * Fetches only what is missing, with the clone's own login; never writes a ref.
 */
export async function resolveReplayBase(input: {
  repoPath: string;
  baseRef: string;
  prNumber: number;
  headSha: string;
  mergeCommitSha: string;
  auth?: GitAuth;
}): Promise<{ headSha: string; baseSha: string }> {
  const { repoPath } = input;
  return withRepoLock(repoPath, async () => {
    const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
    const a = url && input.auth ? await input.auth(url) : { args: [], env: {} };
    const fetchIfMissing = async (sha: string, refspec: string[]) => {
      if (!url || (await revParse(repoPath, `${sha}^{commit}`))) return;
      await git(repoPath, [...a.args, 'fetch', '--no-tags', '--', 'origin', ...refspec], { env: a.env });
    };
    await fetchIfMissing(input.mergeCommitSha, [input.baseRef]);
    await fetchIfMissing(input.headSha, [`refs/pull/${input.prNumber}/head`]);
    if (!(await revParse(repoPath, `${input.mergeCommitSha}^{commit}`)))
      throw new Error('the merge commit of the pull request is not in this clone');
    const parent = await revParse(repoPath, `${input.mergeCommitSha}^1`);
    if (!parent) throw new Error('the merge commit has no parent');
    const base = (await gitOk(repoPath, ['merge-base', parent, input.headSha])).trim();
    if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('no common base for the pull request');
    return { headSha: input.headSha, baseSha: base };
  });
}
