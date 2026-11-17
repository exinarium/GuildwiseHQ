import { describe, expect, it } from 'vitest';
import {
  isReleaseCommit,
  isReleaseMachineryCommit,
  releaseChanges,
  releaseCommitSubject,
  releasePrepCommitSubject,
} from '../src/index.ts';

const c = (sha: string, subject: string) => ({ sha, subject, breakingFooter: false });

describe('release machinery commits', () => {
  it('recognises the subjects the release ship and release prep write', () => {
    expect(isReleaseMachineryCommit(releaseCommitSubject('1.8.0'))).toBe(true);
    expect(isReleaseMachineryCommit(releaseCommitSubject('2.0.0-rc.1'))).toBe(true);
    expect(isReleaseMachineryCommit('chore(release): v1.8.0')).toBe(true);
    expect(isReleaseMachineryCommit(releasePrepCommitSubject('development'))).toBe(true);
    expect(isReleaseCommit(releaseCommitSubject('1.8.0'))).toBe(true);
    expect(isReleaseCommit(releasePrepCommitSubject('development'))).toBe(false);
  });

  it('does not treat other commits as machinery', () => {
    expect(isReleaseMachineryCommit('feat: add release notes')).toBe(false);
    expect(isReleaseMachineryCommit('chore(release): bump the release script')).toBe(false);
    expect(isReleaseMachineryCommit('docs(release): explain the release flow')).toBe(false);
    expect(isReleaseMachineryCommit('fix: chore(release): 1.8.0')).toBe(false);
  });
});

describe('releaseChanges', () => {
  const lastTag = { name: 'v1.8.0', sha: 'aaaaaaa1' };

  it('counts only commits that are not release machinery', () => {
    const facts = {
      lastTag,
      commitsTruncated: false,
      commits: [
        c('1111111a', releasePrepCommitSubject('development')),
        c('2222222b', releaseCommitSubject('1.8.0')),
      ],
    };
    expect(releaseChanges(facts)).toEqual({ real: 0, behindRelease: false });
    facts.commits.push(c('3333333c', 'feat: something new'));
    expect(releaseChanges(facts).real).toBe(1);
  });

  it('treats a truncated list as real work', () => {
    expect(releaseChanges({ lastTag, commitsTruncated: true, commits: [] }).real).toBeGreaterThan(0);
  });

  it('flags facts that still list the release commit of a published ship with another tag', () => {
    const facts = {
      lastTag: { name: 'v1.7.0', sha: 'bbbbbbb1' },
      commitsTruncated: false,
      commits: [c('2222222b0000', 'chore(release): 1.8.0'), c('3333333c', 'feat: shipped in 1.8.0')],
    };
    const published = [{ tag: 'v1.8.0', commitSha: '2222222b' }];
    expect(releaseChanges(facts, published).behindRelease).toBe(true);
    expect(releaseChanges({ ...facts, lastTag }, published).behindRelease).toBe(false);
    expect(releaseChanges(facts, [{ tag: 'v1.8.0', commitSha: '9999999z' }]).behindRelease).toBe(false);
  });
});
