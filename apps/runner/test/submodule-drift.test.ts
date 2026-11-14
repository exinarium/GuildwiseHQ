import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resetSubmoduleDrift, submoduleResetNote } from '../src/git/submodule-drift.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

cleanupTmp();

/** X (the "core") and D that holds X as a submodule at `core`, pinned to X's current main (as in deploy-submodules). */
function twoRepos() {
  const x = makeRepo();
  const d = makeRepo();
  sh(d.clone, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', x.origin, 'core']);
  sh(d.clone, 'git', ['commit', '-m', 'add core']);
  sh(d.clone, 'git', ['push', 'origin', 'main']);
  const pin = sh(join(d.clone, 'core'), 'git', ['rev-parse', 'HEAD']);
  return { x, d, pin };
}

/** A new commit on X's main, pushed from another clone. */
function advanceX(x: TestRepo, file: string): string {
  const other = join(tmp(), 'x-other');
  sh(x.root, 'git', ['clone', x.origin, other]);
  writeFileSync(join(other, file), `${file}\n`);
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', `add ${file}`]);
  sh(other, 'git', ['push', 'origin', 'main']);
  return sh(other, 'git', ['rev-parse', 'HEAD']);
}

/** The submodule checked out at X's newer commit while D still pins the old one. */
function drift(d: TestRepo, sha: string) {
  const core = join(d.clone, 'core');
  sh(core, 'git', ['fetch', 'origin']);
  sh(core, 'git', ['checkout', '-q', sha]);
}

describe('resetSubmoduleDrift (BLOCKERS.md section 3)', () => {
  it('resets a clean drift to the pin; nothing is left for the leftovers commit to put on the gitlink', async () => {
    const { x, d, pin } = twoRepos();
    const newer = advanceX(x, 'feature.txt');
    drift(d, newer);
    expect(sh(d.clone, 'git', ['status', '--porcelain'])).toContain('core');
    const r = await resetSubmoduleDrift(d.clone);
    expect(r.refused).toBeUndefined();
    expect(r.reset).toEqual([{ path: 'core', from: newer, pin }]);
    expect(sh(join(d.clone, 'core'), 'git', ['rev-parse', 'HEAD'])).toBe(pin);
    // what `git add -A` would stage: nothing
    sh(d.clone, 'git', ['add', '-A']);
    expect(sh(d.clone, 'git', ['diff', '--cached', '--name-only'])).toBe('');
    expect(submoduleResetNote(r.reset)).toContain(`core (${newer.slice(0, 10)} -> ${pin.slice(0, 10)})`);
  });

  it('refuses a drifted submodule with uncommitted changes inside and leaves it as it is', async () => {
    const { x, d } = twoRepos();
    const newer = advanceX(x, 'feature.txt');
    drift(d, newer);
    writeFileSync(join(d.clone, 'core', 'wip.txt'), 'work in progress\n');
    const r = await resetSubmoduleDrift(d.clone);
    expect(r.reset).toEqual([]);
    expect(r.refused).toContain('the submodule core is at');
    expect(r.refused).toContain('uncommitted changes inside (wip.txt)');
    expect(sh(join(d.clone, 'core'), 'git', ['rev-parse', 'HEAD'])).toBe(newer);
    expect(existsSync(join(d.clone, 'core', 'wip.txt'))).toBe(true);
  });

  it('leaves a pin change committed on the branch alone', async () => {
    const { x, d } = twoRepos();
    const newer = advanceX(x, 'feature.txt');
    drift(d, newer);
    sh(d.clone, 'git', ['add', 'core']);
    sh(d.clone, 'git', ['commit', '-m', 'bump core']);
    const r = await resetSubmoduleDrift(d.clone);
    expect(r).toEqual({ reset: [] });
    expect(sh(join(d.clone, 'core'), 'git', ['rev-parse', 'HEAD'])).toBe(newer);
  });

  it('never fetches: a pin the submodule clone lacks is refused, even with a file:// origin that has it (B3)', async () => {
    const { x, d, pin } = twoRepos();
    const newer = advanceX(x, 'feature.txt');
    const core = join(d.clone, 'core');
    sh(core, 'git', ['remote', 'set-url', 'origin', `file://${x.origin}`]);
    // the branch pins X's newer commit; the submodule clone has never seen it
    sh(d.clone, 'git', ['update-index', '--cacheinfo', `160000,${newer},core`]);
    sh(d.clone, 'git', ['commit', '-m', 'pin core']);
    const r = await resetSubmoduleDrift(d.clone);
    expect(r.reset).toEqual([]);
    expect(r.refused).toContain("the pinned commit is not in the submodule's clone");
    expect(r.refused).toContain('aom question --topic environment');
    // nothing was fetched into the submodule's clone, and it was not moved
    expect(spawnSync('git', ['cat-file', '-e', `${newer}^{commit}`], { cwd: core }).status).not.toBe(0);
    expect(sh(core, 'git', ['rev-parse', 'HEAD'])).toBe(pin);
  });

  it('a redirected core/.git is not operated on: refused, the repository it points at is untouched (B3)', async () => {
    const { x, d } = twoRepos();
    const newer = advanceX(x, 'feature.txt');
    // a repository the agent owns, with a hook-free config of its own, checked out at the newer commit
    const owned = join(tmp(), 'owned');
    sh(x.root, 'git', ['clone', '-q', x.origin, owned]);
    sh(owned, 'git', ['checkout', '-q', newer]);
    writeFileSync(join(d.clone, 'core', '.git'), `gitdir: ${join(owned, '.git')}\n`);
    const r = await resetSubmoduleDrift(d.clone);
    expect(r.reset).toEqual([]);
    expect(r.refused).toContain('the submodule core is not a checkout the runner manages');
    expect(sh(owned, 'git', ['rev-parse', 'HEAD'])).toBe(newer);
    expect(sh(owned, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('a gitlink the agent made over a fresh git init is not operated on: refused (B3)', async () => {
    const d = makeRepo();
    const evil = join(d.clone, 'evil');
    mkdirSync(evil);
    sh(evil, 'git', ['init', '-q', '-b', 'main']);
    writeFileSync(join(evil, 'a.txt'), 'a\n');
    sh(evil, 'git', ['add', '-A']);
    sh(evil, 'git', ['commit', '-q', '-m', 'a']);
    const head = sh(evil, 'git', ['rev-parse', 'HEAD']);
    sh(d.clone, 'git', ['update-index', '--add', '--cacheinfo', `160000,${'e'.repeat(40)},evil`]);
    const r = await resetSubmoduleDrift(d.clone);
    expect(r.reset).toEqual([]);
    expect(r.refused).toContain('the submodule evil is not a checkout the runner manages');
    expect(sh(evil, 'git', ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('resets even when .gitmodules says update = none or rebase (it always checks the pin out)', async () => {
    for (const mode of ['none', 'rebase']) {
      const { x, d, pin } = twoRepos();
      sh(d.clone, 'git', ['config', '--file', '.gitmodules', 'submodule.core.update', mode]);
      sh(d.clone, 'git', ['config', 'submodule.core.update', mode]);
      sh(d.clone, 'git', ['commit', '-am', `update = ${mode}`]);
      const newer = advanceX(x, 'feature.txt');
      drift(d, newer);
      const r = await resetSubmoduleDrift(d.clone);
      expect(r.refused).toBeUndefined();
      expect(r.reset).toEqual([{ path: 'core', from: newer, pin }]);
      expect(sh(join(d.clone, 'core'), 'git', ['rev-parse', 'HEAD'])).toBe(pin);
      // nothing was rebased onto the pin: X's newer commit is untouched
      expect(sh(join(d.clone, 'core'), 'git', ['cat-file', '-t', newer])).toBe('commit');
    }
  });

  it('a repository without submodules, or with one not initialised, has nothing to reset', async () => {
    expect(await resetSubmoduleDrift(makeRepo().clone)).toEqual({ reset: [] });
    const { d } = twoRepos();
    const fresh = join(tmp(), 'fresh');
    sh(d.root, 'git', ['clone', d.origin, fresh]);
    expect(await resetSubmoduleDrift(fresh)).toEqual({ reset: [] });
  });
});
