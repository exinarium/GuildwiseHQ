import { isSafeGitRef, type RepoOpenPrPayload, type RepoOpenPrResult } from '@aom/shared';
import type { PrCreator } from './gh.ts';
import { defaultBranchOf, git, hasRemote, revParse } from './git.ts';
import type { GitAuth } from './worktrees.ts';

export interface ReleasePrInput {
  payload: RepoOpenPrPayload;
  /** Local clone of the repository. */
  repoPath: string;
  pr: PrCreator;
  auth?: GitAuth;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `repo.open_pr`: a pull request from the repository's working branch (the head) to its main branch (the base; absent:
 * the repository's default branch). Pushes the working branch first when origin does not have it. Answers
 * `nothingToDo` when the working branch is the main branch or has nothing the main branch lacks; a pull request that
 * already exists is reported with its address rather than as a failure. Never throws for expected failures.
 */
export async function openReleasePr(input: ReleasePrInput): Promise<RepoOpenPrResult> {
  const { payload: p, repoPath } = input;
  const head = p.head;
  if (!isSafeGitRef(head)) return { ok: false, error: `refusing unsafe branch name ${JSON.stringify(head)}` };
  if (p.base !== undefined && !isSafeGitRef(p.base))
    return { ok: false, error: `refusing unsafe branch name ${JSON.stringify(p.base)}` };
  const remote = await hasRemote(repoPath);
  if (!remote) return { ok: false, error: 'cannot open a pull request: the repository has no origin remote' };

  const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const a = input.auth && url ? await input.auth(url, p.forge) : { args: [], env: {} };
  const base = p.base ?? (await defaultBranchOf(repoPath));
  if (!base)
    return {
      ok: false,
      error:
        'the main branch cannot be told (the repository has several branches and no default). Set the main branch in the project settings.',
    };
  if (base === head)
    return {
      ok: true,
      base,
      nothingToDo: true,
      notice: `The working branch and the main branch are both ${base}: there is nothing to open a pull request between.`,
    };

  await git(repoPath, [...a.args, 'fetch', '--', 'origin', base], { env: a.env });
  await git(repoPath, [...a.args, 'fetch', '--', 'origin', head], { env: a.env });
  const baseRef = (await revParse(repoPath, `refs/remotes/origin/${base}`)) ? `origin/${base}` : base;
  if (!(await revParse(repoPath, baseRef)))
    return { ok: false, base, error: `the main branch '${base}' does not exist in this repository` };
  const remoteHead = await revParse(repoPath, `refs/remotes/origin/${head}`);
  const localHead = await revParse(repoPath, `refs/heads/${head}`);
  if (!remoteHead && !localHead)
    return {
      ok: false,
      base,
      error: `the working branch '${head}' does not exist yet. It is created from '${base}' when the first card starts.`,
    };
  if (!remoteHead) {
    const push = await git(repoPath, [...a.args, 'push', '-u', 'origin', `${head}:${head}`], { env: a.env });
    if (push.exitCode !== 0)
      return {
        ok: false,
        base,
        error: `could not push '${head}' to origin: ${(push.stderr || push.stdout).trim().slice(0, 300)}`,
      };
  }
  const headRef = remoteHead ? `origin/${head}` : head;
  const ahead = (await git(repoPath, ['rev-list', '--count', `${baseRef}..${headRef}`])).stdout.trim();
  if (ahead === '0')
    return {
      ok: true,
      base,
      nothingToDo: true,
      notice: `The working branch ${head} has nothing the main branch ${base} does not have yet.`,
    };

  try {
    const r = await input.pr.create({
      cwd: repoPath,
      base,
      branch: head,
      title: p.title,
      body: p.body,
      forge: p.forge ?? null,
    });
    if ('unavailable' in r)
      return {
        ok: true,
        base,
        notice: `${r.unavailable}: ${head} is pushed, open the pull request from ${head} to ${base} by hand`,
      };
    return { ok: true, base, ...(r.url ? { url: r.url } : {}) };
  } catch (err) {
    const msg = errMsg(err);
    const existing = /already exists/i.test(msg) ? /https?:\/\/\S+/.exec(msg)?.[0] : undefined;
    if (existing) return { ok: true, base, url: existing, notice: 'A pull request for this already exists' };
    return { ok: false, base, error: msg };
  }
}
