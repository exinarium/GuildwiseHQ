import { join, posix } from 'node:path';
import {
  isSafeGitRef,
  normalizeRemoteUrl,
  type RepoBumpSubmodulePayload,
  type RepoBumpSubmoduleResult,
} from '@aom/shared';
import { isProtectedBranchRejection } from './gh.ts';
import { advanceLocalBranch, git, hasRemote, revParse } from './git.ts';
import { commitEnv, NoCommitIdentityError, requireCommitIdentity } from './identity.ts';
import { integrationBranchName, withIntegrationWorktree } from './integration.ts';
import { withRepoLock } from './repo-lock.ts';
import type { GitAuth } from './worktrees.ts';

export interface BumpSubmoduleInput {
  payload: RepoBumpSubmodulePayload;
  /** Local clone of the deploy repository (D). */
  repoPath: string;
  /** Directory for the throwaway integration worktree. */
  integrationDir: string;
  auth?: GitAuth;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const fail = (error: string, more: Partial<RepoBumpSubmoduleResult> = {}): RepoBumpSubmoduleResult => ({
  ok: false,
  error,
  ...more,
});

/** A push that lost the race with another push to the same branch (git's own wording, several versions and hosts). */
const isMovedRejection = (why: string): boolean =>
  /non-fast-forward|fetch first|stale info|tip of your current branch is behind|failed to update ref/i.test(
    why,
  );

/**
 * The submodules a `.gitmodules` file declares: name, path and url. A relative url (`../core.git`) is resolved against
 * the url of D's own origin, the way git does.
 */
export async function readSubmodules(
  worktree: string,
  originUrl: string,
): Promise<Array<{ name: string; path: string; normalized: string }>> {
  const r = await git(worktree, ['config', '--file', '.gitmodules', '--list', '-z']);
  if (r.exitCode !== 0) return [];
  const byName = new Map<string, { path?: string; url?: string }>();
  for (const entry of r.stdout.split('\0')) {
    const nl = entry.indexOf('\n');
    const key = nl === -1 ? entry : entry.slice(0, nl);
    const value = nl === -1 ? '' : entry.slice(nl + 1);
    const m = /^submodule\.(.+)\.(path|url)$/i.exec(key);
    if (!m?.[1] || !m[2]) continue;
    const cur = byName.get(m[1]) ?? {};
    cur[m[2].toLowerCase() as 'path' | 'url'] = value.trim();
    byName.set(m[1], cur);
  }
  const out: Array<{ name: string; path: string; normalized: string }> = [];
  for (const [name, s] of byName) {
    if (!s.path || !s.url) continue;
    const url = /^\.{1,2}\//.test(s.url)
      ? posix.normalize(`${normalizeRemoteUrl(originUrl)}/${s.url}`)
      : s.url;
    out.push({ name, path: s.path, normalized: normalizeRemoteUrl(url) });
  }
  return out;
}

/**
 * `repo.bump_submodule` (docs/RUNNER.md): points D's submodule pin of X at X's newest merge commit on D's working branch,
 * and pushes. D is the clone at `repoPath`; X is found by url in D's `.gitmodules` on D's working branch, so there is
 * nothing to set up. The pin is written straight into the index (`git update-index --cacheinfo 160000,<sha>,<path>`) in a
 * throwaway integration worktree, so neither X's objects nor an initialised submodule are needed. The commit carries the
 * project's commit identity and a DCO `Signed-off-by` line. Idempotent (a pin that already names the commit makes no
 * commit); never forces a push (origin moved: once more from the new tip); a protected working branch is reported, never
 * worked around with a pull request. Never throws for expected failures.
 */
export async function bumpSubmodule(input: BumpSubmoduleInput): Promise<RepoBumpSubmoduleResult> {
  const { payload: p, repoPath } = input;
  const branch = p.workingBranch;
  if (!isSafeGitRef(branch)) return fail(`refusing unsafe branch name ${JSON.stringify(branch)}`);
  if (p.commit.length < 40) return fail(`the commit ${p.commit} is not a full commit id`);
  if (!(await hasRemote(repoPath))) return fail('cannot update the pin: the repository has no origin remote');
  try {
    return await withRepoLock(repoPath, async () => {
      let last: RepoBumpSubmoduleResult = fail('could not update the pin');
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await attemptBump(input);
        if (r !== 'moved') return r;
        last = fail(`${branch} on origin kept moving while the pin was pushed: try again later`);
      }
      return last;
    });
  } catch (err) {
    if (err instanceof NoCommitIdentityError) return fail(err.message);
    return fail(errMsg(err));
  }
}

async function attemptBump(input: BumpSubmoduleInput): Promise<RepoBumpSubmoduleResult | 'moved'> {
  const { payload: p, repoPath } = input;
  const branch = p.workingBranch;
  const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const a = input.auth && url ? await input.auth(url, p.forge) : { args: [], env: {} };
  const fetched = await git(repoPath, [...a.args, 'fetch', '--', 'origin', branch], { env: a.env });
  if (fetched.exitCode !== 0)
    return fail(
      `could not fetch ${branch} from origin: ${(fetched.stderr || fetched.stdout).trim().slice(0, 300)}`,
    );
  const startPoint = `origin/${branch}`;
  if (!(await revParse(repoPath, startPoint)))
    return fail(`the working branch '${branch}' does not exist on origin`);

  const tempBranch = integrationBranchName(`pin-${p.repoId.slice(0, 8)}`);
  const dir = join(input.integrationDir, `pin-${p.repoId.slice(0, 8)}`);
  const result = await withIntegrationWorktree(
    { repoPath, dir, root: input.integrationDir, tempBranch, startPoint },
    async (wt): Promise<RepoBumpSubmoduleResult | 'moved'> => {
      const found = (await readSubmodules(wt, url)).find(
        (s) => s.normalized === p.submoduleRemoteUrlNormalized,
      );
      if (!found)
        return fail(
          `${p.remoteUrlNormalized} does not contain ${p.submoduleRemoteUrlNormalized} as a submodule on ${branch}`,
          { notSubmodule: true },
        );
      const entry = (await git(wt, ['ls-tree', 'HEAD', '--', found.path])).stdout.trim();
      const m = /^160000 commit ([0-9a-f]{40,64})\t/.exec(entry);
      if (!m?.[1])
        return fail(`${found.path} is named in .gitmodules but is not a submodule in the ${branch} tree`, {
          path: found.path,
        });
      const head = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
      if (m[1] === p.commit || m[1].startsWith(p.commit))
        return { ok: true, unchanged: true, commit: head, path: found.path };

      const id = await requireCommitIdentity(repoPath, p.commitAs);
      const env = commitEnv(id);
      const set = await git(wt, ['update-index', '--add', '--cacheinfo', `160000,${p.commit},${found.path}`]);
      if (set.exitCode !== 0)
        return fail(`could not set the pin: ${(set.stderr || set.stdout).trim().slice(0, 300)}`, {
          path: found.path,
        });
      const commit = await git(
        wt,
        [
          'commit',
          '--no-verify',
          '-m',
          `chore: pin ${found.path} to ${p.commit.slice(0, 10)}`,
          '-m',
          `Points ${found.path} at the merge commit ${p.commit} of ${p.submoduleRemoteUrlNormalized}.`,
          '-m',
          `Signed-off-by: ${id.name} <${id.email}>`,
        ],
        { env },
      );
      if (commit.exitCode !== 0)
        return fail(`could not commit the pin: ${(commit.stderr || commit.stdout).trim().slice(0, 300)}`, {
          path: found.path,
        });
      const newHead = (await git(wt, ['rev-parse', 'HEAD'])).stdout.trim();
      const push = await git(wt, [...a.args, 'push', 'origin', `HEAD:refs/heads/${branch}`], { env: a.env });
      if (push.exitCode !== 0) {
        const why = (push.stderr || push.stdout).trim();
        // checked first: a host that declines a push through a hook words the lost race the same way
        if (isMovedRejection(why)) return 'moved';
        if (isProtectedBranchRejection(why))
          return fail(`${branch} refused the push of the pin: ${why.slice(0, 300)}`, {
            protectedBranch: true,
            path: found.path,
          });
        return fail(`pushing ${branch} failed: ${why.slice(0, 300)}`, { path: found.path });
      }
      return { ok: true, commit: newHead, path: found.path };
    },
  );
  if (!result.ok) return fail(result.error);
  if (result.value !== 'moved' && result.value.ok && result.value.commit && !result.value.unchanged)
    await advanceLocalBranch(repoPath, branch, result.value.commit);
  return result.value;
}
