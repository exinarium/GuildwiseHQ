import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git/git.ts';
import { readSubmodules } from '../git/submodule-pin.ts';
import { hasCommit } from './bundle.ts';

const SHA_RE = /^[0-9a-f]{40}$/;

export interface FillSubmodulesOptions {
  /**
   * Untrusted branch content (a card worktree the runner prepares): a submodule is filled only from the workstation's
   * own clone of its repository, and only when the trusted `.gitmodules` (`allowed`) declares it too. Git never fetches
   * from a url of the branch's `.gitmodules`, and the file protocol is allowed only for that local clone's path.
   */
  localOnly?: boolean;
  /** With `localOnly`: the submodules the trusted ref (the base branch) declares; anything else is not filled. */
  allowed?: ReadonlyArray<{ name: string; path: string; normalized: string }>;
  /** No git command runs past this time (ms since epoch); each one's timeout is cut to what is left. */
  deadline?: number;
  signal?: AbortSignal;
  now?: () => number;
  /** With `localOnly`: a submodule left out for one of the reasons above is listed here (with why), not an error. */
  skipped?: string[];
  /** The paths of the submodules that were filled. */
  filled?: string[];
}

/** A submodule name git may take as part of a `-c submodule.<name>.url=` key (no `=`, no spaces, no control characters). */
const SAFE_NAME_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * A deploy checkout (`git worktree add --detach`) leaves every submodule folder empty, and a build of a repository that
 * holds another one as a submodule (guildwise-cloud holds the core at `core/`) then fails. This fills each submodule at
 * the commit the checkout pins. When this workstation has a clone of the submodule's repository (found by its normalized
 * url, the way the runner finds every repository) the submodule is cloned from that local clone: no second download,
 * and a commit the clone lacks is fetched into it first. Without a local clone git fetches from the submodule's own url.
 * Nothing in the clones' configuration is changed (the local url is only passed for this one command).
 * Returns null when every submodule is filled (or there are none), else what went wrong.
 */
export async function fillDeploySubmodules(
  checkout: string,
  repoPath: string,
  findRepo: (remoteUrlNormalized: string) => Promise<{ localPath: string } | undefined>,
  opts: FillSubmodulesOptions = {},
): Promise<string | null> {
  if (!existsSync(join(checkout, '.gitmodules'))) return null;
  const now = opts.now ?? Date.now;
  /** The git timeout within the budget, or a reason to stop now. */
  const limit = (ms: number): { timeoutMs: number; signal?: AbortSignal } | string => {
    if (opts.signal?.aborted) return 'stopped: the shift ended';
    const left = opts.deadline === undefined ? ms : Math.min(ms, opts.deadline - now());
    if (left <= 0) return 'over the preparation budget';
    return { timeoutMs: left, ...(opts.signal ? { signal: opts.signal } : {}) };
  };
  const originUrl = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const subs = await readSubmodules(checkout, originUrl);
  for (const s of subs) {
    const skip = (why: string) => opts.skipped?.push(`${s.path}: ${why}`);
    if (opts.localOnly) {
      if (!SAFE_NAME_RE.test(s.name)) {
        skip('its name has characters the runner does not pass to git');
        continue;
      }
      const same = opts.allowed?.some(
        (a) => a.name === s.name && a.path === s.path && a.normalized === s.normalized,
      );
      if (!same) {
        skip('the base branch does not declare it like this');
        continue;
      }
    }
    const pinned = (await git(checkout, ['rev-parse', `HEAD:${s.path}`])).stdout.trim();
    if (!SHA_RE.test(pinned)) return `the submodule ${s.path} has no pinned commit in this checkout`;
    const local = await findRepo(s.normalized);
    if (opts.localOnly && !local) {
      skip('no clone of its repository on this workstation');
      continue;
    }
    // A deploy checkout of a merged commit keeps the file protocol for the submodule's own url; prepared (untrusted)
    // content gets it only together with the local clone's path below.
    const args: string[] = opts.localOnly ? [] : ['-c', 'protocol.file.allow=always'];
    if (local) {
      if (!(await hasCommit(local.localPath, pinned))) {
        const a = limit(300_000);
        if (typeof a === 'string') return `the submodule ${s.path}: ${a}`;
        await git(local.localPath, ['fetch', 'origin'], a);
        if (!(await hasCommit(local.localPath, pinned))) {
          const b = limit(300_000);
          if (typeof b === 'string') return `the submodule ${s.path}: ${b}`;
          await git(local.localPath, ['fetch', 'origin', pinned], b);
        }
      }
      if (await hasCommit(local.localPath, pinned))
        args.push(
          ...(opts.localOnly ? ['-c', 'protocol.file.allow=always'] : []),
          '-c',
          `submodule.${s.name}.url=${local.localPath}`,
        );
      else if (opts.localOnly) {
        skip(`the clone of its repository on this workstation lacks ${pinned.slice(0, 10)}`);
        continue;
      }
    }
    const c = limit(600_000);
    if (typeof c === 'string') return `the submodule ${s.path}: ${c}`;
    const r = await git(checkout, [...args, 'submodule', 'update', '--init', '--', s.path], c);
    if (r.exitCode !== 0)
      return `the submodule ${s.path} (${pinned.slice(0, 10)}) could not be checked out: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
    const head = (await git(join(checkout, s.path), ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== pinned)
      return `the submodule ${s.path} is at ${head.slice(0, 10)}, not the pinned ${pinned.slice(0, 10)}`;
    opts.filled?.push(s.path);
  }
  return null;
}
