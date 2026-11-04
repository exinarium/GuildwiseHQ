import { describe, expect, it } from 'vitest';
import {
  CHANGELOG_STEP,
  ChangelogProposalSchema,
  changelogSkeleton,
  checkChangelog,
  describeEntryFinding,
  enabledReleaseDocsPrepSteps,
  entryKey,
  isDuplicateEntry,
  mergeUnreleased,
  missingReleaseDocsPrepRequirement,
  newChangelog,
  ReleaseChangelogOutputSchema,
  ReleaseDocsPrepPayloadSchema,
  ReleaseDocsPrepResultSchema,
  releaseChangelog,
  releaseDocsPrepSteps,
  releaseSectionOf,
  scrubChangelogEntry,
  splitUnreleased,
  unreleasedBullets,
} from '../src/index.ts';

const LOOSE = `# Changelog

All notable changes to Guildwise HQ are documented in this file.

## [Unreleased]

### Added

- Retire a workstation with agent handover. Pick a workstation and move its agents to another one.

- Storage limits for attachments. Set \`AOM_STORAGE_MAX_FILE_BYTES\` to cap a single upload.

## [1.4.0] - 2026-10-01

### Fixed

- Old entry one that stays exactly as written.

[1.4.0]: https://example.invalid/compare
`;

const TIGHT = `# Changelog

All notable changes to Guildwise HQ Platform are documented in this file.

## [Unreleased]

## [0.1.0] - 2026-11-03

### Changed

- first commit subject
- second commit subject
`;

const UNDATED = `# Changelog

## [Unreleased]

### Added

- Retire a workstation with agent handover and much more.

## [1.5.0]

### Added

- Forms in journeys and storage.

## [1.4.0] - 2026-10-01

### Fixed

- Old.
`;

const add = (text: string) => ({ heading: 'Added' as const, text });
const fix = (text: string) => ({ heading: 'Fixed' as const, text });
const ENTRY_A = add('Release prep on the Releases page. Turn it on to write the changelog before a release ships.');
const ENTRY_F = fix('The release page no longer misses entries written under an unknown heading.');

const outside = (md: string) => {
  const s = splitUnreleased(md);
  const lines = md.split('\n');
  return { head: lines.slice(0, (s?.start ?? 0) + 1).join('\n'), tail: lines.slice(s?.end ?? 0).join('\n') };
};

describe('registry: Write changelog', () => {
  it('sits between analyse and commit, on by default, requires analyse', () => {
    expect(releaseDocsPrepSteps().map((s) => s.id)).toEqual(['analyse', 'changelog', 'commit']);
    expect(CHANGELOG_STEP).toMatchObject({ order: 20, defaultOn: true, producesFiles: true, requires: ['analyse'] });
  });
  it('can be unticked, and a run without it has no changelog step', () => {
    expect(enabledReleaseDocsPrepSteps({ steps: { changelog: false } }).map((s) => s.id)).toEqual([
      'analyse',
      'commit',
    ]);
  });
  it('reports a missing required step', () => {
    expect(missingReleaseDocsPrepRequirement(enabledReleaseDocsPrepSteps({ steps: {} }))).toBeNull();
    expect(missingReleaseDocsPrepRequirement(enabledReleaseDocsPrepSteps({ steps: { analyse: false } }))).toEqual({
      step: 'changelog',
      requires: 'analyse',
      message: 'Write changelog needs Analyse changes. Turn it on in the project settings.',
    });
  });
});

describe('checkChangelog', () => {
  it('accepts the two real layouts', () => {
    expect(checkChangelog(LOOSE)).toEqual({ errors: [], warnings: [] });
    expect(checkChangelog(TIGHT)).toEqual({ errors: [], warnings: [] });
    expect(checkChangelog(changelogSkeleton('X')).errors).toEqual([]);
  });
  it('fails an undated pending version heading with the fix', () => {
    const { errors } = checkChangelog(UNDATED);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('## [1.5.0] section without a date (line 9)');
    expect(errors[0]).toContain('Move its entries under ## [Unreleased]');
  });
  it('fails a file without Unreleased, with two, or with Unreleased below a version', () => {
    expect(checkChangelog('# Changelog\n\n## [1.0.0] - 2026-01-01\n').errors[0]).toMatch(/no ## \[Unreleased\]/);
    expect(checkChangelog('## [Unreleased]\n\n## [Unreleased]\n').errors[0]).toMatch(/more than one/);
    expect(checkChangelog('## [1.0.0] - 2026-01-01\n\n## [Unreleased]\n').errors.join(' ')).toMatch(/below the version/);
  });
  it('fails an Unreleased bullet outside a ### heading, and a binary file', () => {
    expect(checkChangelog('## [Unreleased]\n\n- stray\n').errors[0]).toMatch(/line 3 that is not under a ### heading/);
    expect(checkChangelog('## [Unreleased]\u0000').errors[0]).toMatch(/not a readable text file/);
  });
  it('warns about an unknown heading without failing', () => {
    const r = checkChangelog('## [Unreleased]\n\n### Highlights\n\n- Big thing\n');
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toMatch(/'### Highlights'/);
  });
  it('fails a version that is already released', () => {
    expect(checkChangelog(LOOSE, { version: '1.4.0' }).errors[0]).toMatch(/released ## \[1.4.0\]/);
  });
});

describe('changelogSkeleton', () => {
  it('is the header newChangelog writes', () => {
    const md = newChangelog('Guildwise HQ', { version: '0.1.0', date: '2026-11-04', bumps: [], notes: '' }).md;
    expect(md.startsWith(changelogSkeleton('Guildwise HQ').replace(/\n$/, ''))).toBe(true);
    expect(changelogSkeleton('Guildwise HQ').endsWith('## [Unreleased]\n')).toBe(true);
  });
});

describe('unreleasedBullets / duplicates', () => {
  it('lists the Unreleased bullets with their heading', () => {
    expect(unreleasedBullets(LOOSE).map((b) => b.heading)).toEqual(['Added', 'Added']);
    expect(unreleasedBullets('## [Unreleased]\n\n### Fixed\n\n- one\n  two\n')).toEqual([
      { heading: 'Fixed', text: 'one two' },
    ]);
  });
  it('normalises text and catches near-identical wording', () => {
    expect(entryKey('**Retire** a `workstation`, [now](x).')).toBe('retire a workstation now');
    expect(isDuplicateEntry('Retire a workstation.', 'retire a  WORKSTATION')).toBe(true);
    expect(
      isDuplicateEntry(
        'Release prep on the Releases page writes the changelog before every release ships',
        'Release prep on the Releases page writes the changelog before each release ships',
      ),
    ).toBe(true);
    expect(isDuplicateEntry('Fix login', 'Fix logout')).toBe(false);
  });
});

describe('mergeUnreleased', () => {
  it('appends to an existing section in the loose style and keeps every byte outside the block', () => {
    const r = mergeUnreleased(LOOSE, [ENTRY_A]);
    if (r.kind !== 'merged') throw new Error(r.kind);
    expect(r.md).toContain(
      'AOM_STORAGE_MAX_FILE_BYTES` to cap a single upload.\n\n- Release prep on the Releases page.',
    );
    expect(outside(r.md)).toEqual(outside(LOOSE));
    expect(r.added).toEqual([ENTRY_A]);
  });
  it('creates a missing section in Keep a Changelog order', () => {
    const r = mergeUnreleased(LOOSE, [ENTRY_F, ENTRY_A]);
    if (r.kind !== 'merged') throw new Error(r.kind);
    const block = r.md.slice(r.md.indexOf('## [Unreleased]'), r.md.indexOf('## [1.4.0]'));
    expect(block.indexOf('### Added')).toBeLessThan(block.indexOf('### Fixed'));
    expect(block).toMatch(/### Fixed\n\n- The release page no longer misses/);
    expect(block.endsWith('heading.\n\n')).toBe(true);
  });
  it('puts a new heading before a later known one', () => {
    const md = '## [Unreleased]\n\n### Fixed\n\n- A bug that was fixed nicely.\n';
    const r = mergeUnreleased(md, [ENTRY_A]);
    if (r.kind !== 'merged') throw new Error(r.kind);
    expect(r.md.indexOf('### Added')).toBeLessThan(r.md.indexOf('### Fixed'));
  });
  it('fills an empty Unreleased in the tight style of the file', () => {
    const r = mergeUnreleased(TIGHT, [ENTRY_A, add('A second user-facing change worth writing about here.')]);
    if (r.kind !== 'merged') throw new Error(r.kind);
    expect(r.md).toContain(
      '## [Unreleased]\n\n### Added\n\n- Release prep on the Releases page. Turn it on to write the changelog before a release ships.\n- A second',
    );
    expect(r.md).toContain('change worth writing about here.\n\n## [0.1.0] - 2026-11-03');
    expect(outside(r.md)).toEqual(outside(TIGHT));
  });
  it('keeps existing entries and drops duplicates (existing, and within the batch)', () => {
    const r = mergeUnreleased(LOOSE, [
      add('Retire a workstation with agent handover. Pick a workstation and move its agents to another one.'),
      ENTRY_A,
      { ...ENTRY_A },
    ]);
    if (r.kind !== 'merged') throw new Error(r.kind);
    expect(r.added).toHaveLength(1);
    expect(r.duplicates).toHaveLength(2);
    expect(r.md.match(/Retire a workstation/g)).toHaveLength(1);
  });
  it('is idempotent: a second merge of the same entries changes nothing', () => {
    const r1 = mergeUnreleased(LOOSE, [ENTRY_A, ENTRY_F]);
    if (r1.kind !== 'merged') throw new Error(r1.kind);
    const r2 = mergeUnreleased(r1.md, [ENTRY_A, ENTRY_F]);
    expect(r2).toEqual({ kind: 'unchanged', duplicates: [ENTRY_A, ENTRY_F] });
  });
  it('creates a new file from the skeleton that the release commit parses', () => {
    const r = mergeUnreleased(changelogSkeleton('Guildwise HQ'), [ENTRY_A]);
    if (r.kind !== 'merged') throw new Error(r.kind);
    expect(r.md).toBe(
      `# Changelog\n\nAll notable changes to Guildwise HQ are documented in this file.\n\n## [Unreleased]\n\n### Added\n\n- ${ENTRY_A.text}\n`,
    );
    expect(splitUnreleased(r.md)?.body).toBe(`### Added\n\n- ${ENTRY_A.text}`);
    const rel = releaseChangelog(r.md, { version: '1.0.0', date: '2026-11-04', bumps: [] });
    if (rel.kind !== 'rewritten') throw new Error(rel.kind);
    expect(rel.section).toContain(ENTRY_A.text);
    expect(releaseSectionOf(rel.md, '1.0.0')).toContain(ENTRY_A.text);
  });
  it('round trip: the release commit moves the new entries into the release section', () => {
    const r = mergeUnreleased(LOOSE, [ENTRY_A, ENTRY_F]);
    if (r.kind !== 'merged') throw new Error(r.kind);
    const rel = releaseChangelog(r.md, { version: '1.5.0', date: '2026-11-05', bumps: [] });
    if (rel.kind !== 'rewritten') throw new Error(rel.kind);
    expect(rel.section).toContain(ENTRY_A.text);
    expect(rel.section).toContain(ENTRY_F.text);
    expect(rel.section).toContain('Retire a workstation');
    expect(rel.md).toContain('- Old entry one that stays exactly as written.');
  });
  it('keeps CRLF and an unknown heading where it is', () => {
    const md = '## [Unreleased]\r\n\r\n### Highlights\r\n\r\n- Big thing\r\n\r\n## [1.0.0] - 2026-01-01\r\n';
    const r = mergeUnreleased(md, [ENTRY_F]);
    if (r.kind !== 'merged') throw new Error(r.kind);
    expect(r.md).toBe(
      `## [Unreleased]\r\n\r\n### Highlights\r\n\r\n- Big thing\r\n\r\n### Fixed\r\n\r\n- ${ENTRY_F.text}\r\n\r\n## [1.0.0] - 2026-01-01\r\n`,
    );
  });
  it('refuses a malformed file without editing it', () => {
    expect(mergeUnreleased(UNDATED, [ENTRY_A])).toMatchObject({ kind: 'error' });
    expect(mergeUnreleased('# nothing here\n', [ENTRY_A])).toMatchObject({
      kind: 'error',
      message: 'CHANGELOG.md has no ## [Unreleased] section.',
    });
  });
  it('keeps the intro line of the block', () => {
    const md = '## [Unreleased]\n\nA short intro.\n\n### Added\n\n- One user-facing thing.\n';
    const r = mergeUnreleased(md, [ENTRY_A]);
    if (r.kind !== 'merged') throw new Error(r.kind);
    expect(splitUnreleased(r.md)?.intro).toBe('A short intro.');
  });
});

describe('scrubChangelogEntry', () => {
  const publicText = (s: string) =>
    s
      .replace(/(^|[\s(])#\d+\b/g, '$1')
      .replace(/(^|[\s(])@[A-Za-z0-9][A-Za-z0-9_-]*/g, '$1')
      .trim();
  const scrub = (text: string, heading = 'Added', denyList?: string[]) =>
    scrubChangelogEntry({ heading, text }, { publicText, denyList }).map((f) => f.code);

  it('passes a plain user-facing entry, settings, paths, versions and public terms', () => {
    expect(scrub(ENTRY_A.text)).toEqual([]);
    expect(scrub('Storage limits. Set `AOM_STORAGE_MAX_FILE_BYTES` on /delivery/releases to cap uploads.')).toEqual([]);
    expect(scrub('Runs on Node.js 22 and upgrades cleanly from 1.4.0 to 1.5.0 without changes.')).toEqual([]);
  });
  it('flags internal and secret content', () => {
    expect(scrub('Fixed the thing from GWP-74 in the release flow.')).toContain('ticket_key');
    expect(scrub('Fixed the thing in commit 5c6c19fe of the flow.')).toContain('sha');
    expect(scrub('See https://guildwise.example/x for the new release flow.')).toContain('url');
    expect(scrub('Ask admin@example.com about the new release flow.')).toContain('email');
    expect(scrub('The runner now connects to 10.0.0.12 for the release flow.')).toContain('ip_address');
    expect(scrub('The runner now connects to build-box.internal for releases.')).toContain('host_name');
    expect(scrub('The runner now talks to localhost for the release flow.')).toContain('host_name');
    expect(scrub('Set token=abcdef123456 to connect the release flow.')).toContain('secret');
    expect(scrub('Fixes a crash reported by @pieter in the release flow.')).toContain('not_public');
    expect(scrub('Line one of the entry here\nline two')).toContain('multi_line');
    expect(scrub('Too short')).toContain('too_short');
    expect(scrub('x'.repeat(901))).toContain('too_long');
    expect(scrub(ENTRY_A.text, 'Highlights')).toContain('heading');
  });
  it('flags a deny-list name without echoing it', () => {
    const f = scrubChangelogEntry({ heading: 'Added', text: 'Katherine made the release flow much faster.' }, {
      publicText,
      denyList: ['katherine', 'ab'],
    });
    expect(f).toEqual([{ code: 'deny_list' }]);
    expect(describeEntryFinding(2, f[0] as never)).toBe('entry 3: names an internal person, agent or machine');
    expect(describeEntryFinding(1, { code: 'ticket_key', detail: 'GWP-74' })).toBe(
      "entry 2: contains a ticket key 'GWP-74'",
    );
  });
});

describe('schemas', () => {
  it('parses a proposal, a payload and an output', () => {
    expect(
      ChangelogProposalSchema.parse({ entries: [{ heading: 'Added', text: 't', sources: ['abc'] }] }),
    ).toMatchObject({ covered: [], skipped: [] });
    const payload = ReleaseDocsPrepPayloadSchema.parse({
      runId: '00000000-0000-4000-8000-000000000001',
      projectId: '00000000-0000-4000-8000-000000000002',
      repoId: '00000000-0000-4000-8000-000000000003',
      remoteUrlNormalized: 'x',
      releaseBranch: 'release/1.5.0',
      step: 'changelog',
      changelog: { projectName: 'P', entries: [{ heading: 'Fixed', text: 'A fix.', sources: ['s1'] }] },
    });
    expect(payload.changelog?.entries[0]?.heading).toBe('Fixed');
    expect(ReleaseDocsPrepResultSchema.parse({ ok: true, state: 'passed', output: { a: 1 } }).output).toEqual({
      a: 1,
    });
    expect(ReleaseChangelogOutputSchema.parse({ added: [] })).toEqual({
      created: false,
      added: [],
      duplicates: [],
      covered: [],
      skipped: [],
      warnings: [],
    });
  });
});
