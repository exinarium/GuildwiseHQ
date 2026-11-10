import { describe, expect, it } from 'vitest';
import { releaseVersionFromBranch } from '../src/release/user-guide.ts';

describe('releaseVersionFromBranch', () => {
  it('reads the version from a release branch name', () => {
    expect(releaseVersionFromBranch('release/1.6.0')).toBe('1.6.0');
    expect(releaseVersionFromBranch('release/v1.6')).toBe('1.6');
    expect(releaseVersionFromBranch('release-2.0.0-rc.1')).toBe('2.0.0-rc.1');
  });
  it('gives null for other branches', () => {
    expect(releaseVersionFromBranch('main')).toBeNull();
    expect(releaseVersionFromBranch('release/next')).toBeNull();
  });
});
