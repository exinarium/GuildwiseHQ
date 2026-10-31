import { basename } from 'node:path';
import { isSafeGitRef, type RepoOpenPrPayload, type RepoOpenPrResult } from '@aom/shared';
import type { PrCreator } from './gh.ts';
import { ambiguousMainMessage, git, hasRemote, resolveDefaultBranch, revParse } from './git.ts';
import type { GitAuth } from './worktrees.ts';

export interface ReleasePrInput {
  payload: RepoOpenPrPayload;
  /** Local clone of the repository. */
  repoPath: string;
  pr: PrCreator;
  auth?: GitAuth;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface ResolvedReleaseBase {
  ok: true;
  base: string;
  /** Git auth arguments and environment for the forge of origin. */
  a: { args: string[]; env: Record<string, string> };
}

/**
 * The main branch of a repository, resolved as the release PR does: the configured one, else the repository's default
 * branch. Shared by the release PR and the release facts read.
 */
export async function resolveReleaseBase(
  repoPath: string,
  p: { base?: string | undefined; forge?: RepoOpenPrPayload['forge'] },
  auth: GitAuth | undefined,
  what: string,
): Promise<ResolvedReleaseBase | { ok: false; error: string }> {
  const remote = await hasRemote(repoPath);
  if (!remote) return { ok: false, error: `${what}: the repository has no origin remote` };
  const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const a = auth && url ? await auth(url, p.forge) : { args: [], env: {} };
  const found = p.base ? null : await resolveDefaultBranch(repoPath, auth ? { auth } : {});
  if (found && !found.branch && found.ambiguous.length > 1)
    return { ok: false, error: ambiguousMainMessage(basename(repoPath), found.ambiguous) };
  const base = p.base ?? found?.branch;
  if (!base)
    return {
      ok: false,
      error:
        'the main branch cannot be told (the repository has several branches and no default). Set the main branch in the project settings.',
    };
  return { ok: true, base, a };
}

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
  const resolved = await resolveReleaseBase(repoPath, p, input.auth, 'cannot open a pull request');
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { base, a } = resolved;
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
    const push = await git(repoPath, [...a.args, 'push', 'origin', `${head}:${head}`], { env: a.env });
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
