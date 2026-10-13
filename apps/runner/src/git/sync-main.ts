import { basename, join } from 'node:path';
import { isSafeGitRef } from '@aom/shared';
import { isProtectedBranchRejection } from './gh.ts';
import { ambiguousMainMessage, git, gitOk, hasRemote, resolveDefaultBranch, revParse } from './git.ts';
import { identityEnv, withIntegrationWorktree } from './integration.ts';
import { withRepoLock } from './repo-lock.ts';
import type { GitAuth } from './worktrees.ts';

/**
 * Merge the latest main branch first (docs/design/architect-and-workflows.md 2.5). Before the card's worktree is
 * created the runner merges `origin/<main>` into the working branch and pushes it, so every card branch is cut from a
 * working branch that already holds main. When that is not possible (a conflict, a protected or raced working branch)
 * the card branch takes the merge instead, inside the card's worktree: a conflict is left in place for the architect to
 * resolve, or aborted when nobody can resolve it. Nothing here is done by an agent.
 */

export interface SyncMainInput {
  repoPath: string;
  /** The repository's main branch; absent: the clone's default branch (`origin/HEAD`). */
  mainBranch?: string;
  workingBranch: string;
  /** The card ref: names the integration worktree and the merge commit. */
  ref: string;
  /** The runner's integration directory (a throwaway worktree is made below it). */
  integrationDir: string;
  auth?: GitAuth;
  identity?: { name: string; email: string };
}

export type SyncMainOutcome =
  /** Nothing to do: no remote, no main or working branch to compare, or main is already in the working branch. */
  | { kind: 'nothing' }
  /** Main was merged into the working branch and pushed; the card branch is cut from it. */
  | { kind: 'merged_into_working'; commit: string; main: string }
  /** The working branch could not take it: merge main into the card branch once its worktree exists. */
  | {
      kind: 'needs_card_merge';
      reason: 'conflict' | 'protected' | 'push_failed';
      files: string[];
      main: string;
    };

async function pushWorking(
  repoPath: string,
  integration: string,
  working: string,
  auth?: GitAuth,
): Promise<{ ok: true } | { ok: false; why: string; protectedBranch: boolean }> {
  const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const a = auth && url ? await auth(url) : { args: [], env: {} };
  const push = await git(integration, [...a.args, 'push', 'origin', `HEAD:refs/heads/${working}`], {
    env: a.env,
  });
  if (push.exitCode === 0) return { ok: true };
  const why = (push.stderr || push.stdout).trim();
  return { ok: false, why, protectedBranch: isProtectedBranchRejection(why) };
}

/** Step 1 to 4 of the design: merge origin/main into origin/working and push (one retry when the branch moved). */
export async function syncMainIntoWorking(input: SyncMainInput): Promise<SyncMainOutcome> {
  const { repoPath, workingBranch: working } = input;
  if (!isSafeGitRef(working)) return { kind: 'nothing' };
  if (input.mainBranch !== undefined && !isSafeGitRef(input.mainBranch)) return { kind: 'nothing' };
  if (!(await hasRemote(repoPath))) return { kind: 'nothing' };
  return withRepoLock(repoPath, async (): Promise<SyncMainOutcome> => {
    // Unset: the remote's own default (never a guess between main and master; with two candidates nothing is merged).
    const main = input.mainBranch ?? (await resolveDefaultBranch(repoPath, { auth: input.auth })).branch;
    if (!main || main === working || !isSafeGitRef(main)) return { kind: 'nothing' };
    const env = identityEnv(input.identity);
    const message = `Merge ${main} into ${working} (aom ${input.ref})`;

    const attempt = async (): Promise<SyncMainOutcome | 'retry'> => {
      const fetched = await git(repoPath, ['fetch', '--', 'origin', main, working]);
      // A branch that is not on origin (yet) has nothing to sync; a failed fetch (offline) is not a reason to stop the shift.
      if (fetched.exitCode !== 0) return { kind: 'nothing' };
      const mainRef = `refs/remotes/origin/${main}`;
      const workRef = `refs/remotes/origin/${working}`;
      const mainSha = await revParse(repoPath, mainRef);
      if (!mainSha || !(await revParse(repoPath, workRef))) return { kind: 'nothing' };
      if ((await git(repoPath, ['merge-base', '--is-ancestor', mainRef, workRef])).exitCode === 0)
        return { kind: 'nothing' };

      const out = await withIntegrationWorktree(
        {
          repoPath,
          dir: join(input.integrationDir, `${input.ref}-sync`),
          root: input.integrationDir,
          tempBranch: `aom-integration/${input.ref.toLowerCase()}-sync`,
          startPoint: `origin/${working}`,
        },
        async (integration): Promise<SyncMainOutcome | 'retry'> => {
          const m = await git(integration, ['merge', '--no-ff', '-m', message, `origin/${main}`], { env });
          if (m.exitCode !== 0) {
            const files = (await git(integration, ['diff', '--name-only', '--diff-filter=U'])).stdout
              .split('\n')
              .filter(Boolean);
            await git(integration, ['merge', '--abort']);
            return { kind: 'needs_card_merge', reason: 'conflict', files, main: mainSha };
          }
          const commit = await gitOk(integration, ['rev-parse', 'HEAD']);
          const pushed = await pushWorking(repoPath, integration, working, input.auth);
          if (pushed.ok) return { kind: 'merged_into_working', commit, main: mainSha };
          if (pushed.protectedBranch)
            return { kind: 'needs_card_merge', reason: 'protected', files: [], main: mainSha };
          // The working branch moved while we merged: fetch again and retry once; any other failure falls back.
          if (/non-fast-forward|fetch first|rejected|stale info/i.test(pushed.why)) return 'retry';
          return { kind: 'needs_card_merge', reason: 'push_failed', files: [], main: mainSha };
        },
      );
      if (!out.ok) return { kind: 'needs_card_merge', reason: 'push_failed', files: [], main: mainSha };
      return out.value;
    };

    try {
      const first = await attempt();
      if (first !== 'retry') return first;
      const second = await attempt();
      if (second !== 'retry') return second;
      const mainSha = (await revParse(repoPath, `refs/remotes/origin/${main}`)) ?? '';
      return { kind: 'needs_card_merge', reason: 'push_failed', files: [], main: mainSha };
    } catch {
      return { kind: 'nothing' };
    }
  });
}

export type CardMergeOutcome =
  | { result: 'merged_into_card'; commit: string; main: string }
  /** The merge is left in progress in the worktree. */
  | { result: 'conflict_in_card'; files: string[]; main: string }
  | { result: 'up_to_date'; main: string };

/**
 * `git merge --no-ff origin/<main>` inside the card's worktree (step 5, and `aom git merge-main`). A conflict is left in
 * place (the files are listed); the caller aborts it when nobody can resolve it. The worktree must be clean.
 */
export async function mergeMainIntoCard(
  worktree: string,
  opts: { mainBranch?: string; ref: string; identity?: { name: string; email: string }; auth?: GitAuth },
): Promise<CardMergeOutcome | { error: string }> {
  let main = opts.mainBranch;
  if (!main) {
    const found = await resolveDefaultBranch(worktree, opts.auth ? { auth: opts.auth } : {});
    if (!found.branch && found.ambiguous.length > 1)
      return { error: ambiguousMainMessage(basename(worktree), found.ambiguous) };
    main = found.branch ?? undefined;
  }
  if (!main || !isSafeGitRef(main)) return { error: 'the main branch of this repository is not known' };
  if (await hasRemote(worktree)) await git(worktree, ['fetch', '--', 'origin', main]);
  const target = (await revParse(worktree, `refs/remotes/origin/${main}`)) ? `origin/${main}` : main;
  const mainSha = await revParse(worktree, target);
  if (!mainSha) return { error: `the main branch '${main}' does not exist in this repository` };
  if ((await git(worktree, ['merge-base', '--is-ancestor', target, 'HEAD'])).exitCode === 0)
    return { result: 'up_to_date', main: mainSha };
  const m = await git(
    worktree,
    ['merge', '--no-ff', '-m', `Merge ${main} into the card branch (aom ${opts.ref})`, target],
    {
      env: identityEnv(opts.identity),
    },
  );
  if (m.exitCode === 0)
    return {
      result: 'merged_into_card',
      commit: await gitOk(worktree, ['rev-parse', 'HEAD']),
      main: mainSha,
    };
  const files = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout
    .split('\n')
    .filter(Boolean);
  if (files.length === 0) {
    // Not a content conflict (unrelated histories, dirty tree): leave nothing half done.
    await git(worktree, ['merge', '--abort']);
    return { error: `git merge ${target} failed: ${(m.stderr || m.stdout).trim().slice(0, 300)}` };
  }
  return { result: 'conflict_in_card', files, main: mainSha };
}

/** Is a merge in progress in the worktree (conflicted or waiting for `git commit`)? */
export async function mergeInProgress(worktree: string): Promise<boolean> {
  return (await git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).exitCode === 0;
}

export const abortMerge = async (worktree: string): Promise<void> => {
  await git(worktree, ['merge', '--abort']);
};
