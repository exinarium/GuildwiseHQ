import { type ReleaseFacts, ReleaseFactsSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { baseVersion, buildProposal, previewSection } from '../src/release/proposal.ts';

const rule = {
  name: 'runner',
  paths: ['apps/runner/**'],
  versionFile: 'apps/runner/src/version.ts',
  pattern: "RUNNER_VERSION = '(.*)'",
};
const file = (v: string) => `export const RUNNER_VERSION = '${v}';\n`;
const CHANGELOG = (unreleased: string) =>
  `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [1.3.0] - 2026-10-20\n\n### Added\n\n- Old.\n`;

const facts = (over: Partial<ReleaseFacts> = {}): ReleaseFacts =>
  ReleaseFactsSchema.parse({
    headSha: 'a'.repeat(40),
    ahead: 3,
    lastTag: { name: 'v1.3.0', sha: 'b'.repeat(40) },
    existingTags: ['v1.3.0'],
    commits: [],
    changedTotal: 4,
    components: [{ name: 'runner', changedCount: 17, contentAtHead: file('0.1.62'), contentAtTag: file('0.1.62') }],
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
    const e = buildProposal(
      facts({ changelog: CHANGELOG('### Changed\n\n- BREAKING: API gone.\n\n') }),
      [],
    );
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
        components: [{ name: 'runner', changedCount: 0, contentAtHead: file('0.1.63'), contentAtTag: file('0.1.63') }],
      }),
      [rule],
    );
    expect(b.components[0]).toMatchObject({ state: 'unchanged', to: '0.1.63' });
    expect(previewSection('1.4.0', '2026-10-31', b)).toContain('Runner 0.1.63 (unchanged).');
  });

  it('does not double-bump a runner version set by hand since the tag', () => {
    const b = buildProposal(
      facts({
        components: [{ name: 'runner', changedCount: 5, contentAtHead: file('0.1.63'), contentAtTag: file('0.1.62') }],
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
    expect(b.recommended).toMatchObject({ version: '1.4.0', reason: 'minor: 1 feat commit, no breaking changes' });
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

  it('bases the version on the last tag, else the newest changelog version, else 0.0.0', () => {
    expect(baseVersion(facts())).toBe('1.3.0');
    expect(baseVersion(facts({ lastTag: null }))).toBe('1.3.0');
    expect(baseVersion(facts({ lastTag: null, changelog: null }))).toBe('0.0.0');
    expect(baseVersion(facts({ lastTag: { name: 'v2.0.0-rc.1', sha: 'd'.repeat(40) } }))).toBe('2.0.0-rc.1');
  });

  it('raises a component level', () => {
    const b = buildProposal(facts(), [rule], { runner: 'minor' });
    expect(b.components[0]).toMatchObject({ level: 'minor', to: '0.2.0' });
  });
});
