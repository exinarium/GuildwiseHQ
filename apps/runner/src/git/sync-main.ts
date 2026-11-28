import { basename, join } from 'node:path';
import { type CommitAs, isSafeGitRef } from '@aom/shared';
import { describePushRejection, isProtectedBranchRejection } from './gh.ts';
import {
  ambiguousMainMessage,
  git,
  gitOk,
  hasCommit,
  hasRemote,
  moveBranchAt,
  originAuth,
  originTip,
  resolveDefaultBranch,
  revParse,
} from './git.ts';
import { type BoundPostAs, commitEnv, NoCommitIdentityError, requireCommitIdentity } from './identity.ts';
import { integrationBranchName, withIntegrationWorktree } from './integration.ts';
import { knowClone, latestTip, recordTip } from './pushable-tips.ts';
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
  /** The project's "Commit as" setting; absent: the repository's or the workstation's git identity. */
  commitAs?: CommitAs | null;
  /** This repository's entry of the project's post-as plan: with an app it is the app or nothing (fail closed). */
  postAs?: BoundPostAs | null;
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
      /** With an app: what the host refused and the bypass or permission the app needs (absent otherwise). */
      report?: string;
    };

async function pushWorking(
  repoPath: string,
  integration: string,
  working: string,
  auth?: GitAuth,
): Promise<{ ok: true } | { ok: false; why: string; protectedBranch: boolean }> {
  const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const a = auth && url ? await auth(url) : { args: [], env: {} };
  // gate-fixes-2: by the sha the runner just made in its integration worktree
  const head = (await git(integration, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim();
  if (!head) return { ok: false, why: 'the merge result could not be read', protectedBranch: false };
  const push = await git(integration, [...a.args, 'push', 'origin', `${head}:refs/heads/${working}`], {
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
    const env = commitEnv(await requireCommitIdentity(repoPath, input.commitAs, input.postAs));
    const message = `Merge ${main} into ${working}`;

    const attempt = async (): Promise<SyncMainOutcome | 'retry'> => {
      const fa = await originAuth(repoPath, input.auth);
      const fetched = fa
        ? await git(repoPath, [...fa.args, 'fetch', '--', 'origin', main, working], { env: fa.env })
        : { stdout: '', stderr: 'no credentials for origin', exitCode: 1 };
      // A branch that is not on origin (yet) has nothing to sync; a failed fetch (offline) is not a reason to stop the shift.
      if (fetched.exitCode !== 0) return { kind: 'nothing' };
      // gate-fixes-2 Rule B: both tips from ls-remote (never refs/remotes, which an agent session can change), as shas
      const tipOf = async (b: string) => {
        const sha = await originTip(repoPath, b, fa ?? undefined).catch(() => null);
        return sha && (await hasCommit(repoPath, sha)) ? sha : null;
      };
      const mainSha = await tipOf(main);
      const workSha = await tipOf(working);
      if (!mainSha || !workSha) return { kind: 'nothing' };
      if ((await git(repoPath, ['merge-base', '--is-ancestor', mainSha, workSha])).exitCode === 0)
        return { kind: 'nothing' };

      const out = await withIntegrationWorktree(
        {
          repoPath,
          dir: join(input.integrationDir, `${input.ref}-sync`),
          root: input.integrationDir,
          tempBranch: integrationBranchName(`${input.ref.toLowerCase()}-sync`),
          startPoint: workSha,
        },
        async (integration): Promise<SyncMainOutcome | 'retry'> => {
          const m = await git(integration, ['merge', '--no-ff', '-m', message, mainSha], { env });
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
          const app = input.postAs?.source === 'app' ? (input.postAs.app ?? null) : null;
          const report = app ? describePushRejection(pushed.why, app) : null;
          const extra = report ? { report } : {};
          if (pushed.protectedBranch)
            return { kind: 'needs_card_merge', reason: 'protected', files: [], main: mainSha, ...extra };
          // The working branch moved while we merged: fetch again and retry once; any other failure falls back.
          if (/non-fast-forward|fetch first|rejected|stale info/i.test(pushed.why)) return 'retry';
          return { kind: 'needs_card_merge', reason: 'push_failed', files: [], main: mainSha, ...extra };
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
    } catch (err) {
      if (err instanceof NoCommitIdentityError) throw err;
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
  opts: {
    mainBranch?: string;
    ref: string;
    commitAs?: CommitAs | null;
    postAs?: BoundPostAs | null;
    auth?: GitAuth;
  },
): Promise<CardMergeOutcome | { error: string }> {
  let main = opts.mainBranch;
  if (!main) {
    const found = await resolveDefaultBranch(worktree, opts.auth ? { auth: opts.auth } : {});
    if (!found.branch && found.ambiguous.length > 1)
      return { error: ambiguousMainMessage(basename(worktree), found.ambiguous) };
    main = found.branch ?? undefined;
  }
  if (!main || !isSafeGitRef(main)) return { error: 'the main branch of this repository is not known' };
  // gate-fixes-2 Rule B: origin's tip of main from ls-remote, as a sha (never refs/remotes/origin/<main>)
  let target = main;
  if (await hasRemote(worktree)) {
    const a = await originAuth(worktree, opts.auth);
    if (a) await git(worktree, [...a.args, 'fetch', '--', 'origin', main], { env: a.env });
    const sha = await originTip(worktree, main, a ?? undefined).catch(() => null);
    if (sha && (await hasCommit(worktree, sha))) target = sha;
  }
  const mainSha = await revParse(worktree, target);
  if (!mainSha) return { error: `the main branch '${main}' does not exist in this repository` };
  if ((await git(worktree, ['merge-base', '--is-ancestor', target, 'HEAD'])).exitCode === 0)
    return { result: 'up_to_date', main: mainSha };
  // Resolved before git runs: a selected app that cannot mint throws AppIdentityError and nothing is merged.
  const env = commitEnv(await requireCommitIdentity(worktree, opts.commitAs, opts.postAs));
  const mergeArgs = ['merge', '--no-ff', '-m', `Merge ${main} into the card branch`, target];
  // gate-fixes-2 Rework 1 (B3): the merge runs detached at the head read here and moves the branch by compare-and-swap;
  // the result is recorded only when that head was the branch's latest record
  const branch = (await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  const head = (await git(worktree, ['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim();
  if (!branch || !isSafeGitRef(branch) || !head) return { error: 'the card worktree is not on a branch' };
  await knowClone(worktree);
  const trustedBefore = (await latestTip(worktree, `refs/heads/${branch}`))?.sha === head;
  let files: string[] = [];
  const moved = await moveBranchAt(
    worktree,
    branch,
    head,
    () => git(worktree, mergeArgs, { env }),
    async () => {
      files = (await git(worktree, ['diff', '--name-only', '--diff-filter=U'])).stdout
        .split('\n')
        .filter(Boolean);
      await git(worktree, ['merge', '--abort']);
    },
  );
  if (moved.ok) {
    if (trustedBefore) await recordTip(worktree, `refs/heads/${branch}`, moved.sha, 'merged');
    return { result: 'merged_into_card', commit: moved.sha, main: mainSha };
  }
  if (!moved.opFailed) return { error: `the card branch was not moved: ${moved.reason}` };
  if (files.length === 0)
    // Not a content conflict (unrelated histories, dirty tree): nothing is left half done.
    return {
      error: `git merge ${target} failed: ${(moved.opFailed.stderr || moved.opFailed.stdout).trim().slice(0, 300)}`,
    };
  // A conflict is left in the worktree for the agent to resolve (on its branch, attached again): the merge stops before
  // it moves anything, and the commit that resolves it is the session's own (recorded at its shift end, Rule D).
  const again = await git(worktree, mergeArgs, { env });
  if (again.exitCode === 0)
    return {
      result: 'merged_into_card',
      commit: await gitOk(worktree, ['rev-parse', 'HEAD']),
      main: mainSha,
    };
  return { result: 'conflict_in_card', files, main: mainSha };
}

/** Is a merge in progress in the worktree (conflicted or waiting for `git commit`)? */
export async function mergeInProgress(worktree: string): Promise<boolean> {
  return (await git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).exitCode === 0;
}

export const abortMerge = async (worktree: string): Promise<void> => {
  await git(worktree, ['merge', '--abort']);
};
