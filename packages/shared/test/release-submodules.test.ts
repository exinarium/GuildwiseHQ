import { describe, expect, it } from 'vitest';
import { RepoReleaseFactsPayloadSchema, RepoReleaseFactsResultSchema } from '../src/protocol/runner.ts';
import { ReleaseFactsSchema } from '../src/release/dto.ts';
import {
  type ReleaseSubmoduleFacts,
  ReleaseSubmoduleFactsSchema,
  releasePointerGate,
  submoduleLine,
} from '../src/release/submodules.ts';

const PIN = 'abc1234def5678abc1234def5678abc1234def56';
const TAG_SHA = 'fff0000aaa1111bbb2222ccc3333ddd4444eee55';
const REPO = '11111111-1111-4111-8111-111111111111';

const sub = (over: Partial<ReleaseSubmoduleFacts>): ReleaseSubmoduleFacts => ({
  path: 'core',
  url: 'github.com/acme/core',
  pinned: PIN,
  repoId: REPO,
  repoName: 'Core',
  latestTag: { name: 'v1.8.0', sha: TAG_SHA },
  containsTag: 'v1.7.2',
  state: 'behind',
  ...over,
});

describe('submoduleLine', () => {
  it('names the pinned commit, the contained release and the latest release when behind', () => {
    expect(submoduleLine(sub({}))).toBe('core: behind - pinned abc1234 (contains 1.7.2), latest release 1.8.0');
  });
  it('says "contains no release" when no tag is merged into the pin', () => {
    expect(submoduleLine(sub({ containsTag: null }))).toBe(
      'core: behind - pinned abc1234 (contains no release), latest release 1.8.0',
    );
  });
  it('reads "not on a release tag" for an untagged pin ahead of the latest tag', () => {
    expect(submoduleLine(sub({ state: 'not_on_release_tag', containsTag: 'v1.8.0' }))).toBe(
      'core: not on a release tag - pinned abc1234 (contains 1.8.0), latest release 1.8.0',
    );
  });
  it('reads "pinned" with the release', () => {
    expect(submoduleLine(sub({ state: 'pinned', containsTag: 'v1.8.0' }))).toBe('core: pinned - abc1234 is release 1.8.0');
  });
  it('shows the reason for not checked and unknown', () => {
    expect(submoduleLine(sub({ state: 'not_checked', reason: 'points outside this project' }))).toBe(
      'core: not checked - points outside this project',
    );
    expect(submoduleLine(sub({ state: 'unknown', reason: 'no clone of Core on this workstation' }))).toBe(
      'core: unknown - no clone of Core on this workstation',
    );
  });
});

describe('releasePointerGate', () => {
  it('is not blocked for an absent or empty list', () => {
    expect(releasePointerGate(undefined, 'cloud')).toEqual({ blocked: false, message: null, blocking: [], warnings: [] });
    expect(releasePointerGate([], 'cloud').blocked).toBe(false);
  });
  it('never blocks on pinned, not checked or unknown; unknown is a warning', () => {
    const g = releasePointerGate(
      [
        sub({ state: 'pinned' }),
        sub({ path: 'vendor/x', state: 'not_checked', reason: 'points outside this project' }),
        sub({ path: 'lib', state: 'unknown', reason: 'could not fetch' }),
      ],
      'cloud',
    );
    expect(g.blocked).toBe(false);
    expect(g.message).toBeNull();
    expect(g.warnings.map((s) => s.path)).toEqual(['lib']);
  });
  it('blocks on behind with the submodule, pinned commit, latest tag and the fix', () => {
    const g = releasePointerGate([sub({})], 'cloud');
    expect(g.blocked).toBe(true);
    expect(g.blocking).toHaveLength(1);
    expect(g.message).toBe(
      'Cannot ship cloud: core: behind - pinned abc1234 (contains 1.7.2), latest release 1.8.0 of Core. ' +
        'Bump the submodule core to v1.8.0 in cloud and refresh the release.',
    );
  });
  it('blocks on not on a release tag', () => {
    const g = releasePointerGate([sub({ state: 'not_on_release_tag', containsTag: 'v1.8.0' })], 'cloud');
    expect(g.blocked).toBe(true);
    expect(g.message).toContain('not on a release tag');
    expect(g.message).toContain('Bump the submodule core to v1.8.0 in cloud');
  });
});

describe('schemas', () => {
  it('parses a submodule entry and refuses an unknown state', () => {
    expect(ReleaseSubmoduleFactsSchema.parse(sub({}))).toEqual(sub({}));
    expect(() => ReleaseSubmoduleFactsSchema.parse({ ...sub({}), state: 'weird' })).toThrow();
  });
  it('keeps the field absent when a runner does not report submodules', () => {
    const base = { ok: true, headSha: PIN, ahead: 0, lastTag: null };
    expect(RepoReleaseFactsResultSchema.parse(base).submodules).toBeUndefined();
    expect(ReleaseFactsSchema.parse(base).submodules).toBeUndefined();
    expect(ReleaseFactsSchema.parse({ ...base, submodules: [sub({})] }).submodules).toEqual([sub({})]);
  });
  it('accepts a facts payload with and without projectRepos', () => {
    const payload = {
      requestId: REPO,
      projectId: REPO,
      repoId: REPO,
      remoteUrlNormalized: 'github.com/acme/cloud',
      head: 'development',
    };
    expect(RepoReleaseFactsPayloadSchema.parse(payload).projectRepos).toBeUndefined();
    const repos = [{ repoId: REPO, name: 'Core', remoteUrlNormalized: 'github.com/acme/core' }];
    expect(RepoReleaseFactsPayloadSchema.parse({ ...payload, projectRepos: repos }).projectRepos).toEqual(repos);
  });
});
