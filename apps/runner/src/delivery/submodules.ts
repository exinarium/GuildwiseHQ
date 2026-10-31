import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../git/git.ts';
import { readSubmodules } from '../git/submodule-pin.ts';
import { hasCommit } from './bundle.ts';

const SHA_RE = /^[0-9a-f]{40}$/;

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
): Promise<string | null> {
  if (!existsSync(join(checkout, '.gitmodules'))) return null;
  const originUrl = (await git(repoPath, ['remote', 'get-url', 'origin'])).stdout.trim();
  const subs = await readSubmodules(checkout, originUrl);
  for (const s of subs) {
    const pinned = (await git(checkout, ['rev-parse', `HEAD:${s.path}`])).stdout.trim();
    if (!SHA_RE.test(pinned)) return `the submodule ${s.path} has no pinned commit in this checkout`;
    const local = await findRepo(s.normalized);
    const args = ['-c', 'protocol.file.allow=always'];
    if (local) {
      if (!(await hasCommit(local.localPath, pinned))) {
        await git(local.localPath, ['fetch', 'origin'], { timeoutMs: 300_000 });
        if (!(await hasCommit(local.localPath, pinned)))
          await git(local.localPath, ['fetch', 'origin', pinned], { timeoutMs: 300_000 });
      }
      if (await hasCommit(local.localPath, pinned))
        args.push('-c', `submodule.${s.name}.url=${local.localPath}`);
    }
    const r = await git(checkout, [...args, 'submodule', 'update', '--init', '--', s.path], {
      timeoutMs: 600_000,
    });
    if (r.exitCode !== 0)
      return `the submodule ${s.path} (${pinned.slice(0, 10)}) could not be checked out: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
    const head = (await git(join(checkout, s.path), ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== pinned)
      return `the submodule ${s.path} is at ${head.slice(0, 10)}, not the pinned ${pinned.slice(0, 10)}`;
  }
  return null;
}
