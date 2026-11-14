import { type FindRepo, fillSubmodules } from '../git/submodule-fill.ts';

/**
 * A deploy checkout (`git worktree add --detach`) leaves every submodule folder empty, and a build of a repository that
 * holds another one as a submodule (guildwise-cloud holds the core at `core/`) then fails. This fills each submodule at
 * the commit the checkout pins. When this workstation has a clone of the submodule's repository (found by its normalized
 * url, the way the runner finds every repository) the submodule is cloned from that local clone: no second download,
 * and a commit the clone lacks is fetched into it first. Without a local clone git fetches from the submodule's own url.
 * Nothing in the clones' configuration is changed (the url is only passed for this one command; the file protocol only
 * for a registered local clone). The resolve and fill are shared with card and run worktrees (`git/submodule-fill.ts`).
 * Returns null when every submodule is filled (or there are none), else what went wrong.
 */
export async function fillDeploySubmodules(
  checkout: string,
  _repoPath: string,
  findRepo: FindRepo,
): Promise<string | null> {
  const fills = await fillSubmodules(checkout, { findRepo }, { stopOnFirstError: true, timeoutMs: 600_000 });
  const bad = fills.find((f) => f.status === 'failed' || f.status === 'skipped');
  if (!bad) return null;
  if (!bad.pinned)
    return `the submodule ${bad.path} has no pinned commit in this checkout${bad.detail && bad.detail !== 'no pinned commit' ? ` (${bad.detail})` : ''}`;
  if (bad.detail?.startsWith('is at ')) return `the submodule ${bad.path} ${bad.detail}`;
  return `the submodule ${bad.path} (${bad.pinned.slice(0, 10)}) could not be checked out: ${bad.detail ?? 'failed'}`;
}
