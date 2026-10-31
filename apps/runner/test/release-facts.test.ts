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
