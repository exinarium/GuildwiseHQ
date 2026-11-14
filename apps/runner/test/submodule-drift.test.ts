import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resetSubmoduleDrift, submoduleCommitOffPin } from '../src/git/submodule-drift.ts';
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

describe('resetSubmoduleDrift (BLOCKERS.md section 3): the drift is reported, no git runs inside a submodule', () => {
  it('on its pin: nothing to do, nothing refused', async () => {
    const { d } = twoRepos();
    expect(await resetSubmoduleDrift(d.clone)).toEqual({ reset: [] });
  });

  it('off its pin: refused with the checkout the agent can do itself; the submodule is left as it is', async () => {
    const { x, d, pin } = twoRepos();
    const newer = advanceX(x, 'feature.txt');
    drift(d, newer);
    expect(await submoduleCommitOffPin(d.clone, 'core')).toBe(newer);
    const r = await resetSubmoduleDrift(d.clone);
    expect(r.reset).toEqual([]);
    expect(r.refused).toContain(`git -C core checkout ${pin}`);
    expect(r.refused).toContain('aom question --topic environment');
    expect(sh(join(d.clone, 'core'), 'git', ['rev-parse', 'HEAD'])).toBe(newer);
    // the agent does what it was told: accepted
    sh(join(d.clone, 'core'), 'git', ['checkout', '-q', pin]);
    expect(await resetSubmoduleDrift(d.clone)).toEqual({ reset: [] });
  });

  it("never runs a program from the submodule's configuration (a clean filter there leaves no marker)", async () => {
    const { x, d } = twoRepos();
    const newer = advanceX(x, 'feature.txt');
    drift(d, newer);
    const core = join(d.clone, 'core');
    const marker = join(tmp(), 'MARK');
    writeFileSync(join(core, '.gitattributes'), '* filter=pwn\n');
    sh(core, 'git', ['config', 'filter.pwn.clean', `sh -c 'touch ${marker}; cat'`]);
    writeFileSync(join(core, 'feature.txt'), 'changed\n');
    const r = await resetSubmoduleDrift(d.clone);
    expect(r.refused).toContain('instead of its pinned');
    expect(existsSync(marker)).toBe(false);
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

  it('a redirected core/.git is refused, and the repository it points at is untouched', async () => {
    const { x, d } = twoRepos();
    const newer = advanceX(x, 'feature.txt');
    const owned = join(tmp(), 'owned');
    sh(x.root, 'git', ['clone', '-q', x.origin, owned]);
    sh(owned, 'git', ['checkout', '-q', newer]);
    writeFileSync(join(d.clone, 'core', '.git'), `gitdir: ${join(owned, '.git')}\n`);
    const r = await resetSubmoduleDrift(d.clone);
    expect(r.reset).toEqual([]);
    expect(r.refused).toContain('the submodule core is not a checkout the runner manages');
    expect(sh(owned, 'git', ['rev-parse', 'HEAD'])).toBe(newer);
  });

  it('a gitlink the agent made over a fresh git init is refused', async () => {
    const d = makeRepo();
    const evil = join(d.clone, 'evil');
    mkdirSync(evil);
    sh(evil, 'git', ['init', '-q', '-b', 'main']);
    writeFileSync(join(evil, 'a.txt'), 'a\n');
    sh(evil, 'git', ['add', '-A']);
    sh(evil, 'git', ['commit', '-q', '-m', 'a']);
    sh(d.clone, 'git', ['update-index', '--add', '--cacheinfo', `160000,${'e'.repeat(40)},evil`]);
    const r = await resetSubmoduleDrift(d.clone);
    expect(r.reset).toEqual([]);
    expect(r.refused).toContain('the submodule evil is not a checkout the runner manages');
  });

  it('a repository without submodules, or with one not initialised, has nothing to report', async () => {
    const plain = makeRepo();
    expect(await resetSubmoduleDrift(plain.clone)).toEqual({ reset: [] });
    const { d } = twoRepos();
    const fresh = join(tmp(), 'fresh');
    sh(d.root, 'git', ['clone', d.origin, fresh]);
    expect(await resetSubmoduleDrift(fresh)).toEqual({ reset: [] });
  });

  it('reads the commit whatever the submodule HEAD looks like: a branch, packed refs, an odd branch name', async () => {
    const { x, d, pin } = twoRepos();
    const newer = advanceX(x, 'feature.txt');
    drift(d, newer);
    const core = join(d.clone, 'core');
    sh(core, 'git', ['checkout', '-q', '-B', 'work+odd@name', newer]);
    expect(await submoduleCommitOffPin(d.clone, 'core')).toBe(newer);
    sh(core, 'git', ['pack-refs', '--all']);
    expect(await submoduleCommitOffPin(d.clone, 'core')).toBe(newer);
    expect((await resetSubmoduleDrift(d.clone)).refused).toContain(`git -C core checkout ${pin}`);
    sh(core, 'git', ['checkout', '-q', '-B', 'work+odd@name', pin]);
    expect(await submoduleCommitOffPin(d.clone, 'core')).toBeNull();
  });
});
