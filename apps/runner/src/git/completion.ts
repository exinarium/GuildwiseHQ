import { join } from 'node:path';
import { type FinalizeExecutePayload, type FinalizeResult, isSafeGitRef } from '@aom/shared';
import type { BranchRules } from '../forge/types.ts';
import { statusLinesWithoutStubs } from '../adapters/sandbox-placeholders.ts';
import { isProtectedBranchRejection, type PrCreator } from './gh.ts';
import { git, gitOk, hasRemote, revParse } from './git.ts';
import { commitEnv, NoCommitIdentityError, requireCommitIdentity } from './identity.ts';
import { withIntegrationWorktree } from './integration.ts';
import { baseTarget, RebaseConflictError, rebaseOntoBase } from './rebase.ts';
import { withRepoLock } from './repo-lock.ts';
import { ensureWorktree } from './worktrees.ts';

export interface CompletionInput {
  payload: FinalizeExecutePayload;
  /** Local clone of the card's repository. */
  repoPath: string;
  /** Where the card worktree lives (or is recreated) on this workstation. */
  worktreePath: string;
  /** The runner's `worktrees/` directory: card worktrees are confined to it. */
  worktreesDir: string;
  /** Directory for the throwaway integration worktree of a merge. */
  integrationDir: string;
  pr: PrCreator;
  /** Credentials for git against the repository's host (clone, push). Absent in tests: the user's own git setup is used. */
  auth?: (
    url: string,
    forge?: FinalizeExecutePayload['forge'],
  ) => Promise<{ args: string[]; env: Record<string, string> }>;
  /**
   * Branch protection of the working branch, read through the repository's forge adapter (GitHub, GitLab, Azure
   * DevOps, Bitbucket). Null: unknown (not connected, no permission, plain git); the merge is then tried and a
   * rejected push still falls back to a pull request.
   */
  rules?: (
    cwd: string,
    branch: string,
    forge?: FinalizeExecutePayload['forge'],
  ) => Promise<BranchRules | null>;
}

/**
 * What clients see of a card in a commit or a pull request: the tracker ticket key when the card came from a ticket
 * (`DCPL-4276`), else just the title. Never the card ref (`P4-12`): internal references are not shown outside.
 */
const outsideTicket = (p: FinalizeExecutePayload): string | null =>
  p.ticket && p.ticket !== p.ref ? p.ticket : null;
const changeTitle = (p: FinalizeExecutePayload): string => {
  const t = outsideTicket(p);
  return t ? `${t}: ${p.title}` : p.title;
};
const mergeMessage = (p: FinalizeExecutePayload): string => `Merge ${changeTitle(p)}`;

const fail = (action: FinalizeResult['action'], error: string): FinalizeResult => ({
  ok: false,
  action,
  error,
});

/**
 * The completion action of a card (docs/ARCHITECTURE.md sections 13.5, 13.6, 24.13): deterministic runner code, no
 * agent. Rebases the card branch onto the working branch first (a conflict is reported, never resolved), then
 * `merge` (integration worktree on the working branch, `git merge --no-ff`, push the working branch) or `pr` (push the
 * card branch under `<prefix>/<ticket>` + `gh pr create`; without `gh` the branch is pushed and a notice is returned).
 * A card branch is pushed ONLY for `pr` (backlog #61); `push_branch` is retired and refused. Idempotent: a branch
 * already merged reports its merge commit again.
 */
export async function executeCompletion(input: CompletionInput): Promise<FinalizeResult> {
  const { payload: p } = input;
  const action = p.action;
  if (action !== 'merge' && action !== 'pr')
    return fail(
      action,
      `the completion action ${JSON.stringify(action)} is retired: a card branch is only pushed for a pull request. Choose merge or pr`,
    );
  // Owner-controlled refs: refuse anything git could parse as an option or an odd refspec.
  for (const ref of [
    p.branchName,
    p.baseBranch,
    `aom-integration/${p.ref.toLowerCase()}`,
    ...(p.remoteBranch ? [p.remoteBranch] : []),
    ...(p.prBranchPrefix && p.ticket ? [`${p.prBranchPrefix}/${p.ticket}`] : []),
  ])
    if (!isSafeGitRef(ref)) return fail(action, `refusing unsafe branch name ${JSON.stringify(ref)}`);
  let wt: string;
  try {
    const w = await ensureWorktree({
      repoPath: input.repoPath,
      spec: {
        mode: 'reuse',
        repoId: p.repoId,
        remoteUrlNormalized: p.remoteUrlNormalized,
        baseBranch: p.baseBranch,
        branchName: p.branchName,
        path: p.worktreePath ?? input.worktreePath,
      },
      defaultPath: input.worktreePath,
      roots: [input.worktreesDir],
    });
    wt = w.path;
  } catch (err) {
    return fail(action, `the card worktree is not available: ${errMsg(err)}`);
  }

  const dirty = (await statusLinesWithoutStubs(wt)).lines.join('\n').trim();
  if (dirty) return fail(action, `the card worktree has uncommitted changes:\n${dirty.slice(0, 500)}`);

  try {
    await rebaseOntoBase(wt, p.baseBranch, p.commitAs);
  } catch (err) {
    if (err instanceof RebaseConflictError)
      return { ok: false, action, conflict: true, conflictedFiles: err.conflictedFiles, error: err.message };
    if (err instanceof NoCommitIdentityError) return fail(action, err.message);
    return fail(action, `rebase failed: ${errMsg(err)}`);
  }

  if (action === 'merge')
    return merge(input, wt).catch((err) => {
      if (err instanceof NoCommitIdentityError) return fail(action, err.message);
      throw err;
    });
  const remote = await hasRemote(wt);
  if (!remote) return fail(action, 'cannot open a PR: the repository has no origin remote');
  // A pull request goes out under <prefix>/<ticket>.
  const head = await remoteBranchFor(input, wt);
  const push = await pushBranch(input, wt, head);
  if (push.exitCode !== 0) return fail(action, `git push failed: ${(push.stderr || push.stdout).trim()}`);

  try {
    const r = await input.pr.create({
      cwd: wt,
      base: p.baseBranch,
      branch: head,
      title: p.prTitle ?? changeTitle(p),
      body: p.prBody ?? p.title,
      forge: p.forge ?? null,
    });
    if ('unavailable' in r)
      return {
        ok: true,
        action,
        pushedBranch: head,
        notice: `${r.unavailable}: the branch ${head} was pushed, open the pull request by hand`,
      };
    return { ok: true, action, pushedBranch: head, ...(r.url ? { prUrl: r.url } : {}) };
  } catch (err) {
    return fail(action, errMsg(err));
  }
}

/**
 * The name a pull request branch has on origin. A name used before (`remoteBranch`: rework updates the same branch and
 * pull request) wins; else `<prefix>/<ticket>`, with `-2`, `-3` ... when origin already has a branch of that name. Old
 * servers send neither: the card branch name, as before.
 */
async function remoteBranchFor(input: CompletionInput, wt: string): Promise<string> {
  const { payload: p } = input;
  if (p.remoteBranch) return p.remoteBranch;
  if (!p.prBranchPrefix || !p.ticket) return p.branchName;
  const base = `${p.prBranchPrefix}/${p.ticket}`;
  const url = (await git(wt, ['remote', 'get-url', 'origin'])).stdout.trim();
  const a = input.auth && url ? await input.auth(url, p.forge) : { args: [], env: {} };
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const r = await git(
      wt,
      [...a.args, 'ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${name}`],
      {
        env: a.env,
        timeoutMs: 60_000,
      },
    );
    // 2: no such ref (free). Any other failure (offline, auth): keep the first name, the push reports the problem.
    if (r.exitCode === 2) return name;
    if (r.exitCode !== 0) return base;
  }
  return base;
}

/** `git push -u origin <local>:<remote>` with the host's credentials when the runner has any. */
async function pushBranch(input: CompletionInput, wt: string, remoteName?: string) {
  const { payload: p } = input;
  const url = (await git(wt, ['remote', 'get-url', 'origin'])).stdout.trim();
  const a = input.auth && url ? await input.auth(url, p.forge) : { args: [], env: {} };
  const spec =
    remoteName && remoteName !== p.branchName ? `${p.branchName}:refs/heads/${remoteName}` : p.branchName;
  return git(wt, [...a.args, 'push', '-u', 'origin', '--', spec], { env: a.env });
}

async function merge(input: CompletionInput, wt: string): Promise<FinalizeResult> {
  // One integration into the working branch at a time per clone (the "merge latest main first" step shares the lock).
  return withRepoLock(input.repoPath, () => mergeLocked(input, wt));
}

async function mergeLocked(input: CompletionInput, wt: string): Promise<FinalizeResult> {
  const { payload: p, repoPath } = input;
  const base = p.baseBranch;
  const remote = await hasRemote(repoPath);
  // A protected working branch refuses direct pushes: open a change instead of failing on the push (C9).
  if (remote && input.rules) {
    const rules = await input.rules(repoPath, base, p.forge).catch(() => null);
    if (rules && !rules.directPushAllowed) return viaChange(input, wt, base);
  }
  if (remote) await git(repoPath, ['fetch', '--', 'origin', base]);
  const startPoint = await baseTarget(repoPath, base);
  if (!(await revParse(repoPath, startPoint))) return fail('merge', `base branch ${base} not found`);

  // Already merged (a redelivered command): report the existing result.
  const merged = await git(repoPath, ['merge-base', '--is-ancestor', p.branchName, startPoint]);
  if (merged.exitCode === 0)
    return { ok: true, action: 'merge', mergeCommit: (await revParse(repoPath, startPoint)) ?? undefined };

  const env = commitEnv(await requireCommitIdentity(repoPath, p.commitAs));
  const integration = join(input.integrationDir, p.ref);
  const tempBranch = `aom-integration/${p.ref.toLowerCase()}`;
  const result = await withIntegrationWorktree(
    { repoPath, dir: integration, root: input.integrationDir, tempBranch, startPoint },
    async (): Promise<FinalizeResult> => {
      const m = await git(integration, ['merge', '--no-ff', '-m', mergeMessage(p), p.branchName], { env });
      if (m.exitCode !== 0) {
        const files = (await git(integration, ['diff', '--name-only', '--diff-filter=U'])).stdout
          .split('\n')
          .filter(Boolean);
        await git(integration, ['merge', '--abort']);
        return {
          ok: false,
          action: 'merge',
          conflict: true,
          conflictedFiles: files,
          error: `merge conflict in ${files.join(', ')}`,
        };
      }
      const mergeCommit = await gitOk(integration, ['rev-parse', 'HEAD']);
      if (remote) {
        const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
        const a = input.auth && url ? await input.auth(url, p.forge) : { args: [], env: {} };
        const push = await git(integration, [...a.args, 'push', 'origin', `HEAD:refs/heads/${base}`], {
          env: a.env,
        });
        if (push.exitCode !== 0) {
          const why = (push.stderr || push.stdout).trim();
          // The host refused (branch policy we could not read beforehand): fall back to a change.
          if (isProtectedBranchRejection(why)) return viaChange(input, wt, base, why);
          return fail('merge', `pushing ${base} failed: ${why}`);
        }
      }
      await advanceLocalBase(repoPath, base, mergeCommit);
      return { ok: true, action: 'merge', mergeCommit };
    },
  );
  return result.ok ? result.value : fail('merge', result.error);
}

/**
 * The working branch is protected (or refused the push): push the card branch and open a pull/merge request through
 * the repository's forge instead. Reported as `action: 'pr'` with `protectedBranch: true`: the server records the card
 * as a pull request, switches the project's default completion to PR and posts a card message. Nothing changed on
 * the working branch.
 */
async function viaChange(
  input: CompletionInput,
  wt: string,
  base: string,
  reason?: string,
): Promise<FinalizeResult> {
  const { payload: p } = input;
  const head = await remoteBranchFor(input, wt);
  const push = await pushBranch(input, wt, head);
  if (push.exitCode !== 0) return fail('pr', `git push failed: ${(push.stderr || push.stdout).trim()}`);
  const why = reason ? `${base} refused a direct push` : `${base} is protected on the git host`;
  try {
    const r = await input.pr.create({
      cwd: wt,
      base,
      branch: head,
      title: p.prTitle ?? changeTitle(p),
      body: p.prBody ?? p.title,
      forge: p.forge ?? null,
    });
    if ('unavailable' in r)
      return {
        ok: true,
        action: 'pr',
        protectedBranch: true,
        pushedBranch: head,
        notice: `${why}, and a pull request could not be opened (${r.unavailable}): the branch ${head} was pushed, open the pull request by hand`,
      };
    return {
      ok: true,
      action: 'pr',
      protectedBranch: true,
      pushedBranch: head,
      ...(r.url ? { prUrl: r.url } : {}),
      notice: `${why}: opened a pull request instead of merging directly${r.url ? ` (${r.url})` : ''}`,
    };
  } catch (err) {
    return fail('pr', errMsg(err));
  }
}

/** Fast-forwards the clone's local working branch to the merge commit when that is safe (best effort). */
async function advanceLocalBase(repo: string, base: string, sha: string): Promise<void> {
  const local = await revParse(repo, `refs/heads/${base}`);
  if (!local || local === sha) return;
  if ((await git(repo, ['merge-base', '--is-ancestor', local, sha])).exitCode !== 0) return;
  const current = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (current === base) {
    if ((await git(repo, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim()) return;
    await git(repo, ['merge', '--ff-only', sha]);
  } else {
    await git(repo, ['update-ref', `refs/heads/${base}`, sha, local]);
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
