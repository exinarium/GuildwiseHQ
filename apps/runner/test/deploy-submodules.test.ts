import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillDeploySubmodules } from '../src/delivery/submodules.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

cleanupTmp();

/** X (the "core") and D (the "cloud") that holds X as a submodule at `core`, pinned to X's current main. */
function twoRepos() {
  const x = makeRepo();
  const d = makeRepo();
  sh(d.clone, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', x.origin, 'core']);
  sh(d.clone, 'git', ['commit', '-m', 'add core']);
  sh(d.clone, 'git', ['push', 'origin', 'main']);
  return { x, d };
}

/** A new commit on X's main, pushed from another clone (the local clone of X does not have it yet). */
function advanceX(x: TestRepo, file: string): string {
  const other = join(tmp(), 'x-other');
  sh(x.root, 'git', ['clone', x.origin, other]);
  writeFileSync(join(other, file), `${file}\n`);
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', `add ${file}`]);
  sh(other, 'git', ['push', 'origin', 'main']);
  return sh(other, 'git', ['rev-parse', 'HEAD']);
}

/** Pin D's submodule at `sha` and push (what the pin bump does). */
function pinD(d: TestRepo, sha: string) {
  sh(d.clone, 'git', ['update-index', '--cacheinfo', `160000,${sha},core`]);
  sh(d.clone, 'git', ['commit', '-m', `pin core to ${sha.slice(0, 10)}`]);
  sh(d.clone, 'git', ['push', 'origin', 'main']);
}

/** The deploy checkout: a detached worktree of D's clone, as the runner makes it. */
function checkout(d: TestRepo): string {
  const dest = join(tmp(), 'checkout');
  sh(d.clone, 'git', ['worktree', 'add', '--detach', dest, 'HEAD']);
  return dest;
}

describe('deploy checkout of a repository with a submodule', () => {
  it('fills the submodule at the pinned commit from the local clone, fetching a commit the clone lacks', async () => {
    const { x, d } = twoRepos();
    const sha = advanceX(x, 'feature.txt');
    pinD(d, sha);
    const dest = checkout(d);
    expect(existsSync(join(dest, 'core', 'feature.txt'))).toBe(false);
    const seen: string[] = [];
    const err = await fillDeploySubmodules(dest, d.clone, async (n) => {
      seen.push(n);
      return n === x.remoteNormalized ? { localPath: x.clone } : undefined;
    });
    expect(err).toBeNull();
    expect(seen).toEqual([x.remoteNormalized]);
    expect(sh(join(dest, 'core'), 'git', ['rev-parse', 'HEAD'])).toBe(sha);
    expect(readFileSync(join(dest, 'core', 'feature.txt'), 'utf8')).toBe('feature.txt\n');
    // the commit was brought into the local clone of X; its configuration is untouched
    expect(sh(x.clone, 'git', ['cat-file', '-t', sha])).toBe('commit');
    expect(sh(d.clone, 'git', ['config', '--get-regexp', '^submodule\\.']).includes(x.clone)).toBe(false);
  });

  it('without a local clone of the submodule, git fetches it from its own url', async () => {
    const { x, d } = twoRepos();
    const sha = advanceX(x, 'other.txt');
    pinD(d, sha);
    const dest = checkout(d);
    const err = await fillDeploySubmodules(dest, d.clone, async () => undefined);
    // the url in .gitmodules is a local path in this fixture: allowed for the command only
    expect(err).toBeNull();
    expect(sh(join(dest, 'core'), 'git', ['rev-parse', 'HEAD'])).toBe(sha);
  });

  it('the deploy cleanup (remove, else delete and prune) leaves no worktree behind for a checkout with a submodule', async () => {
    const { x, d } = twoRepos();
    const dest = checkout(d);
    expect(await fillDeploySubmodules(dest, d.clone, async () => ({ localPath: x.clone }))).toBeNull();
    // what DeployExecutor's cleanup does
    const { git } = await import('../src/git/git.ts');
    const { rmSync } = await import('node:fs');
    const rm = await git(d.clone, ['worktree', 'remove', '--force', dest]);
    rmSync(dest, { recursive: true, force: true });
    if (rm.exitCode !== 0) await git(d.clone, ['worktree', 'prune']);
    expect(sh(d.clone, 'git', ['worktree', 'list'])).not.toContain(dest);
    expect(existsSync(dest)).toBe(false);
  });

  it('a repository without submodules is left as it is', async () => {
    const x = makeRepo();
    const dest = checkout(x);
    expect(await fillDeploySubmodules(dest, x.clone, async () => undefined)).toBeNull();
  });

  it('a pinned commit that exists nowhere is reported, not deployed half-built', async () => {
    const { x, d } = twoRepos();
    pinD(d, 'a'.repeat(40));
    const dest = checkout(d);
    const err = await fillDeploySubmodules(dest, d.clone, async () => ({ localPath: x.clone }));
    expect(err).toMatch(/^the submodule core \(aaaaaaaaaa\) could not be checked out/);
  });
});
