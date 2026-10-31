import { describe, expect, it } from 'vitest';
import {
  bumpVersion,
  componentBumps,
  componentLine,
  composeReleaseSection,
  hasBreakingFooter,
  notesFromCommits,
  parseConventionalTitle,
  RELEASE_TAG_RE,
  recommendVersion,
  releaseIntro,
  tagVersion,
  validateReleaseVersion,
} from '../src/index.ts';

const c = (subject: string, breakingFooter = false) => ({ sha: 'a'.repeat(40), subject, breakingFooter });
const counts = (added: number, breaking = 0, entries = added + breaking) => ({ added, breaking, entries });

describe('tags and commits', () => {
  it('reads release tags', () => {
    expect(RELEASE_TAG_RE.test('v1.3.0')).toBe(true);
    expect(RELEASE_TAG_RE.test('v1.3.0-rc.1')).toBe(true);
    expect(RELEASE_TAG_RE.test('v1.3.0+build')).toBe(false);
    expect(RELEASE_TAG_RE.test('1.3.0')).toBe(false);
    expect(tagVersion('v1.3.0')).toBe('1.3.0');
    expect(tagVersion('latest')).toBeNull();
  });
  it('parses conventional titles', () => {
    expect(parseConventionalTitle('feat(api)!: drop v1 routes')).toEqual({
      type: 'feat',
      scope: 'api',
      bang: true,
      subject: 'drop v1 routes',
    });
    expect(parseConventionalTitle('fix: a bug')?.bang).toBe(false);
    expect(parseConventionalTitle('Update readme')).toBeNull();
  });
  it('finds a breaking footer', () => {
    expect(hasBreakingFooter('text\n\nBREAKING CHANGE: gone')).toBe(true);
    expect(hasBreakingFooter('BREAKING-CHANGE: gone')).toBe(true);
    expect(hasBreakingFooter('mentions BREAKING CHANGE: inline')).toBe(false);
  });
});

describe('bumpVersion pre-release bases', () => {
  it('uses npm semantics for minor and major', () => {
    expect(bumpVersion('1.2.0-rc.1', 'minor')).toEqual({ ok: true, version: '1.2.0' });
    expect(bumpVersion('2.0.0-rc.1', 'major')).toEqual({ ok: true, version: '2.0.0' });
    expect(bumpVersion('1.2.3-rc.1', 'minor')).toEqual({ ok: true, version: '1.3.0' });
    expect(bumpVersion('1.2.3-rc.1', 'major')).toEqual({ ok: true, version: '2.0.0' });
    expect(bumpVersion('1.2.3', 'minor')).toEqual({ ok: true, version: '1.3.0' });
  });
});

describe('recommendVersion', () => {
  it('minor for Added entries with the reason', () => {
    const r = recommendVersion({ base: '1.3.0', changelog: counts(3), commits: [] });
    expect(r).toMatchObject({
      version: '1.4.0',
      level: 'minor',
      reason: 'minor: 3 Added entries, no breaking changes',
    });
  });
  it('singular and combined reasons', () => {
    expect(recommendVersion({ base: '1.0.0', changelog: counts(1), commits: [] }).reason).toBe(
      'minor: 1 Added entry, no breaking changes',
    );
    expect(
      recommendVersion({ base: '1.0.0', changelog: null, commits: [c('feat: a'), c('feat(x): b')] }).reason,
    ).toBe('minor: 2 feat commits, no breaking changes');
    expect(
      recommendVersion({ base: '1.0.0', changelog: counts(3), commits: [c('feat: a'), c('feat: b')] }).reason,
    ).toBe('minor: 3 Added entries and 2 feat commits, no breaking changes');
  });
  it('major for BREAKING entries, bang commits and footers', () => {
    const e = recommendVersion({ base: '1.3.0', changelog: counts(2, 1), commits: [] });
    expect(e).toMatchObject({ version: '2.0.0', level: 'major', reason: 'major: 1 BREAKING entry' });
    const b = recommendVersion({
      base: '1.3.0',
      changelog: null,
      commits: [c('feat(api)!: drop v1 routes')],
    });
    expect(b.reason).toBe('major: 1 breaking commit (feat(api)!: drop v1 routes)');
    const f = recommendVersion({
      base: '1.3.0',
      changelog: null,
      commits: [c('fix: x', true), c('fix!: y')],
    });
    expect(f.reason).toBe('major: 2 breaking commits');
    const both = recommendVersion({
      base: '1.3.0',
      changelog: counts(0, 1),
      commits: [c('fix!: y'), c('fix: z', true)],
    });
    expect(both.reason).toBe('major: 1 BREAKING entry, 2 breaking commits');
  });
  it('patch otherwise, with and without a changelog', () => {
    const withLog = recommendVersion({
      base: '1.3.0',
      changelog: { added: 0, breaking: 0, entries: 1, sections: [{ name: 'Fixed', count: 1 }] },
      commits: [c('fix: a')],
    });
    expect(withLog).toMatchObject({
      version: '1.3.1',
      level: 'patch',
      reason: 'patch: 1 Fixed entry, no Added entries or breaking changes',
    });
    expect(
      recommendVersion({
        base: '1.3.0',
        changelog: null,
        commits: [c('fix: a'), c('docs: b'), c('x'), c('y')],
      }).reason,
    ).toBe('patch: 4 commits, no feat commits or breaking changes');
  });
  it('handles no previous tag and a pre-release base', () => {
    expect(recommendVersion({ base: '0.0.0', changelog: counts(1), commits: [] }).version).toBe('0.1.0');
    expect(recommendVersion({ base: '1.4.0-rc.1', changelog: counts(1), commits: [] }).version).toBe('1.4.0');
    expect(
      recommendVersion({ base: '1.4.0-rc.1', changelog: counts(0), commits: [c('fix: a')] }).version,
    ).toBe('1.4.0');
  });
});

describe('validateReleaseVersion', () => {
  it('accepts a higher semver, with or without v', () => {
    expect(validateReleaseVersion(' v1.4.0 ', 'v1.3.0', ['v1.3.0'])).toEqual({ ok: true, version: '1.4.0' });
    expect(validateReleaseVersion('2.0.0-rc.1', 'v1.3.0', [])).toEqual({ ok: true, version: '2.0.0-rc.1' });
    expect(validateReleaseVersion('0.0.1', null, [])).toEqual({ ok: true, version: '0.0.1' });
  });
  it('refuses non-semver', () => {
    expect(validateReleaseVersion('1.4', 'v1.3.0', [])).toEqual({
      ok: false,
      message: '1.4 is not a semantic version (use MAJOR.MINOR.PATCH, for example 1.4.0)',
    });
    expect(validateReleaseVersion('abc', null, []).ok).toBe(false);
    expect(validateReleaseVersion('1.4.0+b', null, []).ok).toBe(false);
    expect(validateReleaseVersion('', null, []).ok).toBe(false);
  });
  it('refuses equal and lower versions and existing tags', () => {
    const msg = '1.3.0 is not higher than the last release v1.3.0';
    expect(validateReleaseVersion('1.3.0', 'v1.3.0', [])).toEqual({ ok: false, message: msg });
    expect(validateReleaseVersion('1.2.9', 'v1.3.0', []).ok).toBe(false);
    expect(validateReleaseVersion('1.4.1', 'v1.3.0', ['v1.4.1'])).toEqual({
      ok: false,
      message: 'v1.4.1 already exists as a tag',
    });
  });
});

const rule = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
};
const file = (v: string) => `export const RUNNER_VERSION = '${v}';\n`;

describe('componentBumps', () => {
  it('bumps from the version at the tag', () => {
    const [b] = componentBumps(
      [rule],
      [{ name: 'runner', changedCount: 17, contentAtHead: file('0.1.62'), contentAtTag: file('0.1.62') }],
    );
    expect(b).toMatchObject({ state: 'bump', from: '0.1.62', to: '0.1.63', under: 'apps/runner/' });
    expect(componentLine(b as never)).toBe('runner 0.1.62 -> 0.1.63 (17 files changed under apps/runner/)');
  });
  it('does not bump twice when the head is already set by hand', () => {
    const [b] = componentBumps(
      [rule],
      [{ name: 'runner', changedCount: 4, contentAtHead: file('0.1.63'), contentAtTag: file('0.1.62') }],
    );
    expect(b).toMatchObject({ state: 'already_set', from: '0.1.62', to: '0.1.63' });
    expect(componentLine(b as never)).toContain('already set in apps/runner/src/version.ts');
  });
  it('raises the level per component', () => {
    const [b] = componentBumps(
      [rule],
      [{ name: 'runner', changedCount: 1, contentAtHead: file('0.1.62'), contentAtTag: file('0.1.62') }],
      { runner: 'minor' },
    );
    expect(b).toMatchObject({ state: 'bump', to: '0.2.0', level: 'minor' });
  });
  it('shows unchanged and missing', () => {
    const [u] = componentBumps(
      [rule],
      [{ name: 'runner', changedCount: 0, contentAtHead: file('0.1.63'), contentAtTag: file('0.1.62') }],
    );
    expect(u).toMatchObject({ state: 'unchanged', from: '0.1.63', to: '0.1.63' });
    expect(componentLine(u as never)).toBe('runner 0.1.63 (unchanged)');
    const [m] = componentBumps(
      [rule],
      [{ name: 'runner', changedCount: 3, contentAtHead: null, contentAtTag: null }],
    );
    expect(m?.state).toBe('missing');
    const [m2] = componentBumps(
      [rule],
      [{ name: 'runner', changedCount: 3, contentAtHead: 'nothing', contentAtTag: null }],
    );
    expect(m2?.state).toBe('missing');
  });
  it('uses the head version when the file did not exist at the tag', () => {
    const [b] = componentBumps(
      [rule],
      [{ name: 'runner', changedCount: 2, contentAtHead: file('0.1.5'), contentAtTag: null }],
    );
    expect(b).toMatchObject({ state: 'bump', from: '0.1.5', to: '0.1.6' });
  });
});

describe('release section', () => {
  const bump = componentBumps(
    [rule],
    [{ name: 'runner', changedCount: 2, contentAtHead: file('0.1.62'), contentAtTag: file('0.1.62') }],
  );
  const same = componentBumps(
    [rule],
    [{ name: 'runner', changedCount: 0, contentAtHead: file('0.1.63'), contentAtTag: file('0.1.63') }],
  );
  it('puts the component sentence in front of the intro', () => {
    expect(releaseIntro('Summary.', bump)).toBe('Runner 0.1.63. Summary.');
    expect(releaseIntro('Runner 0.1.62. Summary.', bump)).toBe('Runner 0.1.63. Summary.');
    expect(releaseIntro('Summary.', same)).toBe('Runner 0.1.63 (unchanged). Summary.');
    expect(releaseIntro('Runner 0.1.63 (unchanged). Summary.', same)).toBe(
      'Runner 0.1.63 (unchanged). Summary.',
    );
    expect(releaseIntro('Summary.', [])).toBe('Summary.');
  });
  it('composes the section', () => {
    expect(composeReleaseSection('1.4.0', '2026-10-31', 'Runner 0.1.63.', '### Added\n\n- x')).toBe(
      '## [1.4.0] - 2026-10-31\n\nRunner 0.1.63.\n\n### Added\n\n- x',
    );
    expect(composeReleaseSection('1.4.0', '2026-10-31', '', '### Fixed\n\n- y')).toBe(
      '## [1.4.0] - 2026-10-31\n\n### Fixed\n\n- y',
    );
  });
  it('builds notes from commit titles', () => {
    expect(notesFromCommits([c('feat: a'), c('chore(release): 1.3.0'), c('fix: b')])).toBe(
      '- feat: a\n- fix: b',
    );
  });
});
