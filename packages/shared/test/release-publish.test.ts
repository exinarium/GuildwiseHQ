import { describe, expect, it } from 'vitest';
import {
  changelogSection,
  decideTag,
  forgeHasReleasePages,
  isLatestRelease,
  noReleasePageText,
  releaseTitle,
  repoTagUrl,
} from '../src/index.ts';

const MD = `# Changelog

## [Unreleased]

## [1.4.0] - 2026-11-01

Runner 0.1.63.

### Added

- One.

## [1.3.0] - 2026-10-20

### Added

- Old.

[1.4.0]: https://example.test/compare
`;

describe('changelogSection', () => {
  it('returns one version section without its heading', () => {
    expect(changelogSection(MD, '1.4.0')).toBe('Runner 0.1.63.\n\n### Added\n\n- One.');
  });
  it('is null when the version is absent', () => {
    expect(changelogSection(MD, '9.9.9')).toBeNull();
  });
});

describe('decideTag', () => {
  const t = 'v1.4.0';
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  it('creates a missing tag', () => {
    expect(decideTag({ tag: t, target: A, remote: null, local: null })).toEqual({ action: 'create' });
  });
  it('reports a remote tag on the target', () => {
    expect(decideTag({ tag: t, target: A, remote: A, local: null })).toEqual({ action: 'report' });
  });
  it('pushes a local tag the remote does not have', () => {
    expect(decideTag({ tag: t, target: A, remote: null, local: A })).toEqual({ action: 'push' });
  });
  it('refuses a tag on another commit and never moves it', () => {
    expect(decideTag({ tag: t, target: A, remote: B, local: null }).action).toBe('refuse');
    expect(decideTag({ tag: t, target: A, remote: null, local: B }).action).toBe('refuse');
  });
});

describe('isLatestRelease', () => {
  it('is latest when it is the highest release tag', () => {
    expect(isLatestRelease('1.4.0', ['v1.3.0', 'v1.4.0'])).toBe(true);
  });
  it('is not latest for a hotfix below a higher release', () => {
    expect(isLatestRelease('1.3.1', ['v1.3.0', 'v1.4.0'])).toBe(false);
  });
  it('is never latest for a pre-release, and ignores higher pre-releases', () => {
    expect(isLatestRelease('2.0.0-rc.1', [])).toBe(false);
    expect(isLatestRelease('1.4.0', ['v1.3.0', 'v1.5.0-rc.1'])).toBe(true);
  });
});

describe('release naming and forges', () => {
  it('builds the title from the release name', () => {
    expect(releaseTitle(' Guildwise HQ ', '1.4.0')).toBe('Guildwise HQ 1.4.0');
  });
  it('links tags per forge, none for plain git', () => {
    expect(repoTagUrl('https://github.com/o/r.git', 'v1.4.0')).toBe('https://github.com/o/r/tree/v1.4.0');
    expect(repoTagUrl('https://gitlab.com/g/r.git', 'v1.4.0')).toBe('https://gitlab.com/g/r/-/tags/v1.4.0');
    expect(repoTagUrl('ssh://git@git.example.test/r.git', 'v1.4.0', 'git')).toBeNull();
  });
  it('knows which forges have release pages and says so when not', () => {
    expect(forgeHasReleasePages('github')).toBe(true);
    expect(forgeHasReleasePages('gitlab')).toBe(true);
    expect(forgeHasReleasePages('azure-devops')).toBe(false);
    expect(noReleasePageText('azure-devops', 'v1.4.0')).toContain('No release page was created');
  });
});
