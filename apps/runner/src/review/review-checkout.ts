import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeGitRef, type ReviewerRunSpec } from '@aom/shared';
import { createSandboxPlaceholders } from '../adapters/sandbox-placeholders.ts';
import { git, gitOk, revParse } from '../git/git.ts';
import { withRepoLock } from '../git/repo-lock.ts';
import type { GitAuth } from '../git/worktrees.ts';

export class ReviewCheckoutError extends Error {}

/** The pull request moved since the run was queued: the head the host has now is not the one the run names. */
export class ReviewHeadMovedError extends ReviewCheckoutError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`the pull request head is now ${actual.slice(0, 12)}, not ${expected.slice(0, 12)}`);
  }
}

/** Adds or removes write permission bits for everyone on a tree (symlinks are left alone). Best effort per entry. */
export function setTreeWritable(root: string, writable: boolean): void {
  const walk = (p: string): void => {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    const mode = st.mode & 0o7777;
    const next = writable ? mode | 0o200 : mode & ~0o222;
    // a directory must be writable before its entries can be listed and changed by the remover, and after for the reader
    if (writable && next !== mode) chmodSync(p, next);
    if (st.isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    if (!writable && next !== mode) chmodSync(p, next);
  };
  walk(root);
}

/** Removes a run folder, including the read-only checkout inside it. Never throws. */
export async function removeRunDir(runDir: string): Promise<void> {
  try {
    setTreeWritable(runDir, true);
  } catch {
    // remove what can be removed
  }
  await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
}

export interface ReviewCheckout {
  /** The standalone repository: no remote, detached at the pull request head, read-only on disk. */
  path: string;
  headSha: string;
}

/**
 * A clean, isolated, read-only checkout of a pull request head. The runner fetches the head into the owner's clone
 * under a private ref (the clone's own login does the network work), builds a STANDALONE repository from it with a
 * local fetch (its own `.git`, no remote, no credential configuration, no hooks) and takes the write bit away from the
 * whole tree. The private refs are deleted again. Anything that fails removes the run folder.
 */
export async function createReviewCheckout(input: {
  repoPath: string;
  runDir: string;
  spec: ReviewerRunSpec;
  auth?: GitAuth;
}): Promise<ReviewCheckout> {
  const { repoPath, runDir, spec } = input;
  if (!isSafeGitRef(spec.baseRef)) throw new ReviewCheckoutError(`refusing unsafe base ref ${spec.baseRef}`);
  const checkout = join(runDir, 'checkout');
  const headRef = `refs/guildwise/review/${spec.runId}`;
  const baseRef = `refs/guildwise/review/${spec.runId}-base`;
  try {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await withRepoLock(repoPath, async () => {
      try {
        const url = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
        if (url) {
          const a = input.auth ? await input.auth(url) : { args: [], env: {} };
          const f = await git(
            repoPath,
            [...a.args, 'fetch', '--no-tags', '--', 'origin', `+refs/pull/${spec.prNumber}/head:${headRef}`],
            { env: a.env },
          );
          if (f.exitCode !== 0)
            throw new ReviewCheckoutError(
              `fetching the pull request failed: ${f.stderr.trim().slice(0, 300)}`,
            );
          if (!(await revParse(repoPath, spec.baseSha))) {
            await git(repoPath, [...a.args, 'fetch', '--no-tags', '--', 'origin', spec.baseRef], {
              env: a.env,
            });
          }
        }
        const head = await revParse(repoPath, headRef);
        if (!head) throw new ReviewCheckoutError('the pull request head is not in this clone');
        if (head !== spec.headSha) throw new ReviewHeadMovedError(spec.headSha, head);
        if (!(await revParse(repoPath, spec.baseSha)))
          throw new ReviewCheckoutError('the base commit of the pull request is not in this clone');
        await gitOk(repoPath, ['update-ref', baseRef, spec.baseSha]);
        // the standalone repository: a local fetch of the two commits, never a remote
        await gitOk(runDir, ['init', '-q', '--template=', 'checkout']);
        await gitOk(checkout, [
          'fetch',
          '-q',
          '--no-tags',
          repoPath,
          `+${headRef}:refs/review/head`,
          `+${baseRef}:refs/review/base`,
        ]);
      } finally {
        await git(repoPath, ['update-ref', '-d', headRef]).catch(() => undefined);
        await git(repoPath, ['update-ref', '-d', baseRef]).catch(() => undefined);
      }
    });
    await gitOk(checkout, ['checkout', '-q', '--detach', spec.headSha]);
    // placeholders first (the sandbox mounts over these names), then the write bit goes
    createSandboxPlaceholders(checkout);
    setTreeWritable(checkout, false);
    return { path: checkout, headSha: spec.headSha };
  } catch (err) {
    await removeRunDir(runDir);
    throw err;
  }
}

/** Removes a run's checkout and everything else in its folder. Never throws. */
export const removeReviewCheckout = removeRunDir;
