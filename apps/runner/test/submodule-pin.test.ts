import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoBumpSubmodulePayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { bumpSubmodule, readSubmodules } from '../src/git/submodule-pin.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

cleanupTmp();

const OLD_PIN = '1'.repeat(40);
const NEW_PIN = 'a'.repeat(40);
const SUB_URL = 'git@github.com:acme/core.git';
const SUB_NORMALIZED = 'github.com/acme/core';
const AS = { name: 'Pat Owner', email: 'pat@example.test' };

/** A deploy repository D whose `core` submodule is pinned to a commit that exists in no clone (the gitlink needs no objects). */
function deployRepo(urlInGitmodules = SUB_URL): TestRepo {
  const repo = makeRepo();
  writeFileSync(
    join(repo.clone, '.gitmodules'),
    `[submodule "core"]\n\tpath = core\n\turl = ${urlInGitmodules}\n`,
  );
  sh(repo.clone, 'git', ['add', '.gitmodules']);
  sh(repo.clone, 'git', ['update-index', '--add', '--cacheinfo', `160000,${OLD_PIN},core`]);
  sh(repo.clone, 'git', ['commit', '-m', 'add the core submodule']);
  mkdirSync(join(repo.clone, 'core')); // an uninitialised submodule is an empty directory
  sh(repo.clone, 'git', ['push', 'origin', 'main']);
  return repo;
}

const payload = (repo: TestRepo, over: Partial<RepoBumpSubmodulePayload> = {}): RepoBumpSubmodulePayload => ({
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d2',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: repo.remoteNormalized,
  workingBranch: 'main',
  submoduleRemoteUrlNormalized: SUB_NORMALIZED,
  commit: NEW_PIN,
  commitAs: AS,
  ...over,
});

const run = (repo: TestRepo, over: Partial<RepoBumpSubmodulePayload> = {}) =>
  bumpSubmodule({ payload: payload(repo, over), repoPath: repo.clone, integrationDir: tmp('pin-int-') });

const pinOnOrigin = (repo: TestRepo) =>
  sh(repo.origin, 'git', ['ls-tree', 'refs/heads/main', '--', 'core']).split(/\s+/)[2];
const hook = (repo: TestRepo, script: string, name = 'pre-receive') => {
  const f = join(repo.origin, 'hooks', name);
  writeFileSync(f, `#!/bin/sh\n${script}\n`);
  chmodSync(f, 0o755);
};

describe('repo.bump_submodule', () => {
  it('pins the submodule to a commit that is not in the clone, signs off, pushes and brings the local branch along', async () => {
    const repo = deployRepo();
    const before = sh(repo.origin, 'git', ['rev-parse', 'refs/heads/main']);
    const res = await run(repo);
    expect(res).toMatchObject({ ok: true, path: 'core' });
    expect(res.unchanged).toBeUndefined();
    const tip = sh(repo.origin, 'git', ['rev-parse', 'refs/heads/main']);
    expect(res.commit).toBe(tip);
    expect(tip).not.toBe(before);
    expect(pinOnOrigin(repo)).toBe(NEW_PIN);
    // exactly one commit, on top of the old tip, only the pin changed
    expect(sh(repo.origin, 'git', ['rev-list', '--count', `${before}..${tip}`])).toBe('1');
    expect(sh(repo.origin, 'git', ['diff', '--name-only', before, tip])).toBe('core');
    const msg = sh(repo.origin, 'git', ['log', '-1', '--format=%B', tip]);
    expect(msg).toContain(`chore: pin core to ${NEW_PIN.slice(0, 10)}`);
    expect(msg).toContain(NEW_PIN);
    expect(msg).toContain('Signed-off-by: Pat Owner <pat@example.test>');
    expect(sh(repo.origin, 'git', ['log', '-1', '--format=%an <%ae>|%cn', tip])).toBe(
      'Pat Owner <pat@example.test>|Pat Owner',
    );
    // the clone's working branch followed
    expect(sh(repo.clone, 'git', ['rev-parse', 'HEAD'])).toBe(tip);
    // the clone has no objects of the submodule commit and needed none
    expect(() => sh(repo.clone, 'git', ['cat-file', '-e', NEW_PIN])).toThrow();
  });

  it('matches the submodule url in any form (https, no .git, other case)', async () => {
    const repo = deployRepo('https://GitHub.com/Acme/core');
    expect(await run(repo)).toMatchObject({ ok: true });
    expect(pinOnOrigin(repo)).toBe(NEW_PIN);
  });

  it('is idempotent: a pin that already names the commit makes no commit and answers the current head', async () => {
    const repo = deployRepo();
    expect(await run(repo, { commit: OLD_PIN })).toMatchObject({ ok: true, unchanged: true, path: 'core' });
    const tip = sh(repo.origin, 'git', ['rev-parse', 'refs/heads/main']);
    const again = await run(repo);
    expect(again.ok).toBe(true);
    const second = await run(repo);
    expect(second).toMatchObject({ ok: true, unchanged: true, commit: again.commit });
    expect(sh(repo.origin, 'git', ['rev-list', '--count', `${tip}..refs/heads/main`])).toBe('1');
  });

  it('retries once from the new tip when origin moved meanwhile, and never forces', async () => {
    const repo = deployRepo();
    const flag = join(repo.root, 'moved-once');
    hook(
      repo,
      `if [ ! -e "${flag}" ]; then
  touch "${flag}"
  unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH
  tip=$(git rev-parse refs/heads/main)
  c=$(GIT_AUTHOR_NAME=o GIT_AUTHOR_EMAIL=o@x.test GIT_COMMITTER_NAME=o GIT_COMMITTER_EMAIL=o@x.test git commit-tree -p "$tip" -m 'someone else pushed' "$tip^{tree}")
  git update-ref refs/heads/main "$c"
  echo "! [rejected] main -> main (fetch first)" >&2
  exit 1
fi`,
    );
    const res = await run(repo);
    expect(res).toMatchObject({ ok: true });
    const log = sh(repo.origin, 'git', ['log', '--format=%s', '-3', 'refs/heads/main']).split('\n');
    expect(log[0]).toContain('chore: pin core');
    expect(log[1]).toBe('someone else pushed');
    expect(pinOnOrigin(repo)).toBe(NEW_PIN);
  });

  it('gives up with a clear message when origin keeps moving', async () => {
    const repo = deployRepo();
    hook(repo, `echo "! [rejected] main -> main (fetch first)" >&2\nexit 1`);
    const res = await run(repo);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/kept moving/);
    expect(pinOnOrigin(repo)).toBe(OLD_PIN);
  });

  it('says so when the repository does not contain the submodule', async () => {
    const repo = deployRepo();
    const res = await run(repo, { submoduleRemoteUrlNormalized: 'github.com/acme/other' });
    expect(res).toMatchObject({ ok: false, notSubmodule: true });
    expect(res.error).toContain('does not contain github.com/acme/other as a submodule');
    expect(pinOnOrigin(repo)).toBe(OLD_PIN);
  });

  it('says so when the repository has no .gitmodules at all', async () => {
    const repo = makeRepo();
    expect(await run(repo)).toMatchObject({ ok: false, notSubmodule: true });
  });

  it("reports a refused push with git's message", async () => {
    const repo = deployRepo();
    hook(repo, `echo "denied by the test policy" >&2\nexit 1`, 'update');
    const res = await run(repo);
    expect(res.ok).toBe(false);
    expect(res.protectedBranch).toBeUndefined();
    expect(res.error).toContain('denied by the test policy');
    expect(pinOnOrigin(repo)).toBe(OLD_PIN);
  });

  it('reports a protected working branch as such and opens nothing', async () => {
    const repo = deployRepo();
    hook(
      repo,
      `echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1`,
    );
    const res = await run(repo);
    expect(res).toMatchObject({ ok: false, protectedBranch: true });
    expect(res.error).toContain('GH006');
  });

  it('refuses unsafe branch names and short commit ids', async () => {
    const repo = deployRepo();
    expect((await run(repo, { workingBranch: '--upload-pack=x' })).ok).toBe(false);
    expect((await run(repo, { commit: 'abc1234' })).ok).toBe(false);
  });

  it('reads submodules with a relative url against the origin url', async () => {
    const repo = makeRepo();
    writeFileSync(
      join(repo.clone, '.gitmodules'),
      '[submodule "a.b"]\n\tpath = libs/a\n\turl = ../core.git\n[submodule "c"]\n\tpath = c\n\turl = https://example.test/x/c\n',
    );
    const subs = await readSubmodules(repo.clone, 'git@github.com:acme/cloud.git');
    expect(subs).toEqual([
      { name: 'a.b', path: 'libs/a', normalized: 'github.com/acme/core' },
      { name: 'c', path: 'c', normalized: 'example.test/x/c' },
    ]);
  });
});
