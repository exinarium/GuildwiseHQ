import { compareSemver, type ReleaseFacts, ReleaseFactsSchema, tagVersion } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { baseVersion, buildProposal, previewSection, releaseBase } from '../src/release/proposal.ts';

const rule = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
};
const file = (v: string) => `export const RUNNER_VERSION = '${v}';\n`;
const CHANGELOG = (unreleased: string) =>
  `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [1.3.0] - 2026-10-20\n\n### Added\n\n- Old.\n`;

/** A changelog whose newest dated section is `version`. */
const CL = (version: string, unreleased: string) =>
  `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [${version}] - 2026-11-01\n\n### Fixed\n\n- Old.\n`;

const facts = (over: Partial<ReleaseFacts> = {}): ReleaseFacts =>
  ReleaseFactsSchema.parse({
    headSha: 'a'.repeat(40),
    ahead: 3,
    lastTag: { name: 'v1.3.0', sha: 'b'.repeat(40) },
    existingTags: ['v1.3.0'],
    commits: [],
    changedTotal: 4,
    components: [
      { name: 'runner', changedCount: 17, contentAtHead: file('0.1.62'), contentAtTag: file('0.1.62') },
    ],
    changelog: CHANGELOG('Runner 0.1.62.\n\n### Added\n\n- One.\n- Two.\n- Three.\n\n'),
    ...over,
  });

describe('buildProposal', () => {
  it('recommends the next minor for Added entries, with the reason and the preview', () => {
    const b = buildProposal(facts(), [rule]);
    expect(b.recommended).toEqual({
      version: '1.4.0',
      level: 'minor',
      reason: 'minor: 3 Added entries, no breaking changes',
    });
    expect(b.components[0]).toMatchObject({ state: 'bump', from: '0.1.62', to: '0.1.63', changedCount: 17 });
    expect(previewSection('1.4.0', '2026-10-31', b)).toBe(
      '## [1.4.0] - 2026-10-31\n\nRunner 0.1.63.\n\n### Added\n\n- One.\n- Two.\n- Three.',
    );
    expect(b.notesSource).toBe('changelog');
    expect(b.notesEditable).toBe(false);
  });

  it('recommends major for a BREAKING entry or a bang commit', () => {
    const e = buildProposal(facts({ changelog: CHANGELOG('### Changed\n\n- BREAKING: API gone.\n\n') }), []);
    expect(e.recommended.version).toBe('2.0.0');
    const c = buildProposal(
      facts({
        changelog: CHANGELOG('### Fixed\n\n- A fix.\n\n'),
        commits: [{ sha: 'c'.repeat(40), subject: 'feat(api)!: drop v1 routes', breakingFooter: false }],
      }),
      [],
    );
    expect(c.recommended).toMatchObject({ version: '2.0.0', level: 'major' });
  });

  it('recommends patch for fixes only, and names the section', () => {
    const b = buildProposal(facts({ changelog: CHANGELOG('### Fixed\n\n- A fix.\n\n') }), []);
    expect(b.recommended).toEqual({
      version: '1.3.1',
      level: 'patch',
      reason: 'patch: 1 Fixed entry, no Added entries or breaking changes',
    });
  });

  it('shows the runner as unchanged and writes the intro for it', () => {
    const b = buildProposal(
      facts({
        components: [
          { name: 'runner', changedCount: 0, contentAtHead: file('0.1.63'), contentAtTag: file('0.1.63') },
        ],
      }),
      [rule],
    );
    expect(b.components[0]).toMatchObject({ state: 'unchanged', to: '0.1.63' });
    expect(previewSection('1.4.0', '2026-10-31', b)).toContain('Runner 0.1.63 (unchanged).');
  });

  it('does not double-bump a runner version set by hand since the tag', () => {
    const b = buildProposal(
      facts({
        components: [
          { name: 'runner', changedCount: 5, contentAtHead: file('0.1.63'), contentAtTag: file('0.1.62') },
        ],
      }),
      [rule],
    );
    expect(b.components[0]).toMatchObject({ state: 'already_set', from: '0.1.62', to: '0.1.63' });
  });

  it('uses the commits alone and their titles as notes without a CHANGELOG.md', () => {
    const b = buildProposal(
      facts({
        changelog: null,
        commits: [
          { sha: '1'.repeat(40), subject: 'feat: new thing', breakingFooter: false },
          { sha: '2'.repeat(40), subject: 'fix: old thing', breakingFooter: false },
        ],
      }),
      [],
    );
    expect(b.recommended).toMatchObject({
      version: '1.4.0',
      reason: 'minor: 1 feat commit, no breaking changes',
    });
    expect(b.changelog).toBeNull();
    expect(b.notes).toBe('- feat: new thing\n- fix: old thing');
    expect(b.notesSource).toBe('commits');
    expect(b.notesEditable).toBe(true);
  });

  it('falls back to the commits when the Unreleased section is empty', () => {
    const b = buildProposal(
      facts({
        changelog: CHANGELOG(''),
        commits: [{ sha: '1'.repeat(40), subject: 'fix: x', breakingFooter: false }],
      }),
      [],
    );
    expect(b.changelog).toMatchObject({ present: true, empty: true });
    expect(b.recommended.reason).toBe('patch: 1 commit, no feat commits or breaking changes');
  });

  it('bases the version on the newest tag, else the newest changelog version, else 0.0.0', () => {
    expect(baseVersion(facts())).toBe('1.3.0');
    expect(baseVersion(facts({ lastTag: null }))).toBe('1.3.0');
    expect(baseVersion(facts({ lastTag: null, existingTags: [], changelog: null }))).toBe('0.0.0');
    expect(baseVersion(facts({ lastTag: { name: 'v2.0.0-rc.1', sha: 'd'.repeat(40) } }))).toBe('2.0.0-rc.1');
  });

  it('takes the newest tag when the changelog is behind it or missing (the 1.8.0 case)', () => {
    const behind = facts({
      lastTag: { name: 'v1.7.2', sha: 'b'.repeat(40) },
      existingTags: ['v1.8.0', 'v1.7.2'],
      changelog: CL('1.7.2', '### Fixed\n\n- A fix.\n\n'),
    });
    expect(releaseBase(behind)).toEqual({
      version: '1.8.0',
      source: 'tag',
      tag: 'v1.8.0',
      changelogVersion: '1.7.2',
    });
    expect(baseVersion(behind)).toBe('1.8.0');
    expect(releaseBase(facts({ ...behind, changelog: null }))).toMatchObject({
      version: '1.8.0',
      source: 'tag',
    });
  });

  it('recommends above the newest tag by commit type: feat 1.9.0, fix 1.8.1, breaking 2.0.0', () => {
    const at = (subject: string) =>
      buildProposal(
        facts({
          lastTag: { name: 'v1.7.2', sha: 'b'.repeat(40) },
          existingTags: ['v1.8.0', 'v1.7.2'],
          changelog: CL('1.7.2', ''),
          commits: [{ sha: 'c'.repeat(40), subject, breakingFooter: false }],
        }),
        [],
      );
    expect(at('feat: x').recommended.version).toBe('1.9.0');
    expect(at('fix: x').recommended.version).toBe('1.8.1');
    expect(at('feat!: x').recommended.version).toBe('2.0.0');
    const b = at('fix: x');
    expect(b).toMatchObject({ base: '1.8.0', baseSource: 'tag', newestTag: 'v1.8.0' });
  });

  it('takes a newer dated changelog version when the tags are behind it', () => {
    const f = (subject: string) =>
      facts({
        lastTag: { name: 'v1.7.2', sha: 'b'.repeat(40) },
        existingTags: ['v1.7.2'],
        changelog: CL('1.8.0', ''),
        commits: [{ sha: 'c'.repeat(40), subject, breakingFooter: false }],
      });
    expect(releaseBase(f('fix: x'))).toEqual({
      version: '1.8.0',
      source: 'changelog',
      tag: 'v1.7.2',
      changelogVersion: '1.8.0',
    });
    expect(buildProposal(f('fix: x'), []).recommended.version).toBe('1.8.1');
    expect(buildProposal(f('feat: x'), []).recommended.version).toBe('1.9.0');
  });

  it('takes the highest dated changelog version, not the first, and ignores undated sections', () => {
    const md =
      '# Changelog\n\n## [Unreleased]\n\n## [1.9.0]\n\n## [1.7.0] - 2026-01-01\n\n## [1.8.0] - 2026-02-01\n';
    expect(releaseBase(facts({ lastTag: null, existingTags: [], changelog: md }))).toEqual({
      version: '1.8.0',
      source: 'changelog',
      tag: null,
      changelogVersion: '1.8.0',
    });
  });

  it('keeps the base when the changelog and the tags agree (the tag is the source)', () => {
    expect(releaseBase(facts())).toEqual({
      version: '1.3.0',
      source: 'tag',
      tag: 'v1.3.0',
      changelogVersion: '1.3.0',
    });
    expect(buildProposal(facts(), [rule]).recommended.version).toBe('1.4.0');
  });

  it('without tags uses the changelog as before, and 0.0.0 with neither', () => {
    expect(releaseBase(facts({ lastTag: null, existingTags: [] }))).toMatchObject({
      version: '1.3.0',
      source: 'changelog',
      tag: null,
    });
    expect(releaseBase(facts({ lastTag: null, existingTags: [], changelog: null }))).toEqual({
      version: '0.0.0',
      source: 'none',
      tag: null,
      changelogVersion: null,
    });
  });

  it('always recommends strictly above the newest tag', () => {
    const cases: Array<Partial<ReleaseFacts>> = [
      {
        lastTag: { name: 'v1.7.2', sha: 'b'.repeat(40) },
        existingTags: ['v1.8.0', 'v1.7.2'],
        changelog: null,
      },
      { lastTag: null, existingTags: ['v2.0.0-rc.1'], changelog: CL('1.9.0', '') },
      {
        lastTag: { name: 'v1.8.0', sha: 'b'.repeat(40) },
        existingTags: ['v1.8.0'],
        changelog: CL('1.9.0', ''),
      },
      {},
    ];
    for (const c of cases) {
      for (const subject of ['fix: a', 'feat: a', 'feat!: a', 'chore: a']) {
        const b = buildProposal(
          facts({ ...c, commits: [{ sha: 'c'.repeat(40), subject, breakingFooter: false }] }),
          [],
        );
        const tag = b.newestTag as string;
        expect(compareSemver(b.recommended.version, tagVersion(tag) as string)).toBeGreaterThan(0);
      }
    }
  });

  it('raises a component level', () => {
    const b = buildProposal(facts(), [rule], { runner: 'minor' });
    expect(b.components[0]).toMatchObject({ level: 'minor', to: '0.2.0' });
  });
});
