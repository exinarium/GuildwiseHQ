import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RepoReleaseFactsPayload } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { readReleaseFacts } from '../src/git/release-facts.ts';
import { cleanupTmp, makeRepo, sh } from './helpers.ts';

cleanupTmp();

const rule = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
};

const payload = (
  repo: { remoteNormalized: string },
  over: Partial<RepoReleaseFactsPayload> = {},
): RepoReleaseFactsPayload => ({
  requestId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d1',
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d2',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: repo.remoteNormalized,
  head: 'develop',
  components: [rule],
  ...over,
});

function commit(clone: string, file: string, text: string, message: string) {
  mkdirSync(dirname(join(clone, file)), { recursive: true });
  writeFileSync(join(clone, file), text);
  sh(clone, 'git', ['add', '-A']);
  sh(clone, 'git', ['commit', '-m', message]);
}

const refs = (dir: string) => sh(dir, 'git', ['for-each-ref', '--format=%(refname) %(objectname)']);

/** main with a tagged release, then `develop` with commits on top. */
function tagged() {
  const repo = makeRepo();
  commit(
    repo.clone,
    'apps/runner/src/version.ts',
    "export const RUNNER_VERSION = '0.1.62';\n",
    'feat: runner',
  );
  commit(repo.clone, 'CHANGELOG.md', '## [Unreleased]\n\n### Added\n\n- x\n', 'docs: changelog');
  sh(repo.clone, 'git', ['tag', '-a', 'v1.3.0', '-m', 'Guildwise HQ 1.3.0']);
  sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
  sh(repo.clone, 'git', ['checkout', '-b', 'develop']);
  return repo;
}

describe('repo.release_facts', () => {
  it('reads the last tag, commits, changed counts and files since the tag', async () => {
    const repo = tagged();
    commit(repo.clone, 'apps/runner/src/a.ts', 'a', 'feat(runner): add a');
    commit(repo.clone, 'apps/runner/src/b.ts', 'b', 'fix!: drop b\n\nBREAKING CHANGE: b is gone');
    commit(
      repo.clone,
      'apps/runner/src/version.ts',
      "export const RUNNER_VERSION = '0.1.63';\n",
      'chore: bump',
    );
    commit(repo.clone, 'CHANGELOG.md', '## [Unreleased]\n\n### Added\n\n- y\n', 'docs: more');
    sh(repo.clone, 'git', ['push', '-u', 'origin', 'develop']);
    const before = refs(repo.origin);
    const r = await readReleaseFacts({ payload: payload(repo), repoPath: repo.clone });
    expect(r.ok).toBe(true);
    expect(r.base).toBe('main');
    expect(r.lastTag?.name).toBe('v1.3.0');
    expect(r.existingTags).toEqual(['v1.3.0']);
    expect(r.ahead).toBe(4);
    expect(r.commits.map((c) => c.subject)).toEqual([
      'docs: more',
      'chore: bump',
      'fix!: drop b',
      'feat(runner): add a',
    ]);
    expect(r.commits.find((c) => c.subject === 'fix!: drop b')?.breakingFooter).toBe(true);
    expect(r.commitsTruncated).toBe(false);
    expect(r.components).toHaveLength(1);
    expect(r.components[0]?.changedCount).toBe(3);
    // the hand-bumped version file: 0.1.63 at the head, 0.1.62 at the tag
    expect(r.components[0]?.contentAtHead).toContain("'0.1.63'");
    expect(r.components[0]?.contentAtTag).toContain("'0.1.62'");
    expect(r.changelog).toContain('- y');
    expect(r.changedTotal).toBe(4);
    // read-only: origin is exactly as it was
    expect(refs(repo.origin)).toBe(before);
  });

  it('reports every file as changed when there is no tag, and null for a missing CHANGELOG', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['checkout', '-b', 'develop']);
    commit(
      repo.clone,
      'apps/runner/src/version.ts',
      "export const RUNNER_VERSION = '0.1.0';\n",
      'feat: first',
    );
    sh(repo.clone, 'git', ['push', '-u', 'origin', 'develop']);
    const r = await readReleaseFacts({ payload: payload(repo), repoPath: repo.clone });
    expect(r.ok).toBe(true);
    expect(r.lastTag).toBeNull();
    expect(r.existingTags).toEqual([]);
    expect(r.changelog).toBeNull();
    expect(r.components[0]).toMatchObject({ changedCount: 1, contentAtTag: null });
    expect(r.commits.length).toBeGreaterThan(0);
  });

  it('counts a pre-release tag as the last tag and picks the highest tag', async () => {
    const repo = tagged();
    commit(repo.clone, 'x.txt', 'x', 'feat: x');
    sh(repo.clone, 'git', ['tag', 'v1.4.0-rc.1']);
    sh(repo.clone, 'git', ['tag', 'v1.3.1']);
    sh(repo.clone, 'git', ['tag', 'not-a-release']);
    commit(repo.clone, 'y.txt', 'y', 'fix: y');
    sh(repo.clone, 'git', ['push', '-u', 'origin', 'develop']);
    const r = await readReleaseFacts({ payload: payload(repo), repoPath: repo.clone });
    expect(r.lastTag?.name).toBe('v1.4.0-rc.1');
    expect(r.existingTags).toEqual(['v1.4.0-rc.1', 'v1.3.1', 'v1.3.0']);
    expect(r.commits.map((c) => c.subject)).toEqual(['fix: y']);
  });

  it('answers a missing branch, an unsafe ref and no remote without throwing', async () => {
    const repo = tagged();
    const gone = await readReleaseFacts({ payload: payload(repo, { head: 'nope' }), repoPath: repo.clone });
    expect(gone.ok).toBe(false);
    expect(gone.error).toContain("'nope'");
    const unsafe = await readReleaseFacts({
      payload: payload(repo, { head: '--upload-pack=x' }),
      repoPath: repo.clone,
    });
    expect(unsafe.ok).toBe(false);
    expect(unsafe.error).toContain('unsafe');
  });
});

describe('repo.release_facts submodule pointers', () => {
  const POINTED_ID = '019e3f6a-7b1c-7a2d-8c3e-0123456789c1';

  /** A project repository with releases v1.7.2 and v1.8.0 and one untagged commit after v1.8.0. */
  function pointedRepo(withTags = true) {
    const repo = makeRepo();
    commit(repo.clone, 'lib.ts', '1', 'feat: one');
    if (withTags) sh(repo.clone, 'git', ['tag', '-a', 'v1.7.2', '-m', '1.7.2']);
    const old = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
    commit(repo.clone, 'lib.ts', '2', 'feat: two');
    if (withTags) sh(repo.clone, 'git', ['tag', '-a', 'v1.8.0', '-m', '1.8.0']);
    const latest = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
    commit(repo.clone, 'lib.ts', '3', 'feat: three');
    const ahead = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
    sh(repo.clone, 'git', ['push', 'origin', 'main', '--tags']);
    return { repo, old, latest, ahead };
  }

  /** The superproject's develop pins `core` (url = the pointed origin) at `sha`. */
  function superWith(url: string, sha: string) {
    const repo = tagged();
    writeFileSync(join(repo.clone, '.gitmodules'), `[submodule "core"]\n\tpath = core\n\turl = ${url}\n`);
    sh(repo.clone, 'git', ['add', '.gitmodules']);
    sh(repo.clone, 'git', ['update-index', '--add', '--cacheinfo', `160000,${sha},core`]);
    sh(repo.clone, 'git', ['commit', '-m', 'chore: pin core']);
    sh(repo.clone, 'git', ['push', '-u', 'origin', 'develop']);
    return repo;
  }

  const read = (
    sup: { clone: string; remoteNormalized: string },
    pointed: { remoteNormalized: string },
    clone: string | undefined,
    over: Partial<RepoReleaseFactsPayload> = {},
  ) =>
    readReleaseFacts({
      payload: payload(sup, {
        projectRepos: [
          { repoId: POINTED_ID, name: 'pointed', remoteUrlNormalized: pointed.remoteNormalized },
        ],
        ...over,
      }),
      repoPath: sup.clone,
      findRepo: async (n) => (n === pointed.remoteNormalized && clone ? { localPath: clone } : undefined),
    });

  it('reads pinned when the pin is the latest release tag commit', async () => {
    const p = pointedRepo();
    const sup = superWith(p.repo.origin, p.latest);
    const r = await read(sup, p.repo, p.repo.clone);
    expect(r.ok).toBe(true);
    expect(r.submodules).toEqual([
      {
        path: 'core',
        url: p.repo.remoteNormalized,
        pinned: p.latest,
        repoId: POINTED_ID,
        repoName: 'pointed',
        latestTag: { name: 'v1.8.0', sha: p.latest },
        containsTag: 'v1.8.0',
        state: 'pinned',
      },
    ]);
  });

  it('reads behind when the latest tag is not in the pinned commit', async () => {
    const p = pointedRepo();
    const sup = superWith(p.repo.origin, p.old);
    const [s] = (await read(sup, p.repo, p.repo.clone)).submodules ?? [];
    expect(s?.state).toBe('behind');
    expect(s?.pinned).toBe(p.old);
    expect(s?.latestTag?.name).toBe('v1.8.0');
    expect(s?.containsTag).toBe('v1.7.2');
  });

  it('reads not_on_release_tag for an untagged pin ahead of the latest tag', async () => {
    const p = pointedRepo();
    const sup = superWith(p.repo.origin, p.ahead);
    const [s] = (await read(sup, p.repo, p.repo.clone)).submodules ?? [];
    expect(s?.state).toBe('not_on_release_tag');
    expect(s?.containsTag).toBe('v1.8.0');
  });

  it('fetches the tags of the pointed clone before comparing', async () => {
    const p = pointedRepo();
    const clone = join(p.repo.root, 'second');
    sh(p.repo.root, 'git', ['clone', '--no-tags', p.repo.origin, clone]);
    expect(sh(clone, 'git', ['tag', '--list'])).toBe('');
    const sup = superWith(p.repo.origin, p.latest);
    const [s] = (await read(sup, p.repo, clone)).submodules ?? [];
    expect(s?.state).toBe('pinned');
  });

  it('is not checked when the url points outside the project or no list was sent', async () => {
    const p = pointedRepo();
    const sup = superWith(p.repo.origin, p.latest);
    const [outside] = (await read(sup, p.repo, p.repo.clone, { projectRepos: [] })).submodules ?? [];
    expect(outside).toMatchObject({
      path: 'core',
      pinned: p.latest,
      state: 'not_checked',
      reason: 'points outside this project',
    });
    expect(outside?.repoId).toBeUndefined();
    const legacy = await readReleaseFacts({ payload: payload(sup), repoPath: sup.clone });
    expect(legacy.submodules?.[0]?.state).toBe('not_checked');
  });

  it('is not checked when the pointed repository has no release tags', async () => {
    const p = pointedRepo(false);
    const sup = superWith(p.repo.origin, p.latest);
    const [s] = (await read(sup, p.repo, p.repo.clone)).submodules ?? [];
    expect(s).toMatchObject({
      state: 'not_checked',
      reason: 'pointed has no release tags',
      repoId: POINTED_ID,
    });
  });

  it('is unknown with the reason when the pointed repository cannot be resolved', async () => {
    const p = pointedRepo();
    const sup = superWith(p.repo.origin, p.old);
    const [noClone] = (await read(sup, p.repo, undefined)).submodules ?? [];
    expect(noClone).toMatchObject({ state: 'unknown', reason: 'no clone of pointed on this workstation' });
    const broken = join(p.repo.root, 'broken');
    sh(p.repo.root, 'git', ['clone', p.repo.origin, broken]);
    sh(broken, 'git', ['remote', 'set-url', 'origin', join(p.repo.root, 'missing.git')]);
    const [noFetch] = (await read(sup, p.repo, broken)).submodules ?? [];
    expect(noFetch?.state).toBe('unknown');
    expect(noFetch?.reason).toMatch(/^could not fetch the tags of pointed: /);
  });

  it('leaves the field absent for a repository without submodules', async () => {
    const repo = tagged();
    commit(repo.clone, 'apps/runner/src/a.ts', 'a', 'feat: a');
    sh(repo.clone, 'git', ['push', '-u', 'origin', 'develop']);
    const r = await readReleaseFacts({ payload: payload(repo, { projectRepos: [] }), repoPath: repo.clone });
    expect(r.ok).toBe(true);
    expect('submodules' in r).toBe(false);
  });
});
