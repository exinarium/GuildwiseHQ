import {
  mergeUnreleased,
  type ReleaseDocsPrepSummary,
  releaseChangelog,
  scrubChangelogEntry,
} from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { buildReleases, parseChangelog, parseUnreleased, publicText } from '../src/blog/releases.ts';
import {
  coveredSourcesOf,
  decideChangelogDispatch,
  NEEDS_ANALYSE,
  NEEDS_RUNNER,
  storedChangelogOutput,
  storedStepOutput,
  summarySources,
} from '../src/release/docs-prep-changelog.ts';

const summary = (shas: string[], head = 'h1'): ReleaseDocsPrepSummary => ({
  repoName: 'GuildwiseHQ',
  branch: 'release/1.5.0',
  headSha: head,
  base: { kind: 'tag', tag: 'v1.4.0', sha: 'b0' },
  commitCount: shas.length,
  commits: shas.map((sha) => ({ sha, subject: `feat ${sha}`, author: 'x', date: '2026-11-01' })),
  commitsTruncated: false,
  merges: [],
  cards: [],
  areas: [],
});

const GOOD = '# Changelog\n\n## [Unreleased]\n\n## [1.4.0] - 2026-10-01\n\n### Fixed\n\n- Old.\n';
const UNDATED = '# Changelog\n\n## [Unreleased]\n\n## [1.5.0]\n\n### Added\n\n- Pending.\n';

describe('Write changelog dispatch decision', () => {
  const base = { hasCapability: true, facts: null, covered: new Set<string>() };
  it('fails without an analysis (Analyse changes off)', () => {
    expect(decideChangelogDispatch({ ...base, summary: null })).toEqual({
      kind: 'fail',
      error: NEEDS_ANALYSE,
    });
  });
  it('fails on a runner without the changelog capability', () => {
    expect(decideChangelogDispatch({ ...base, summary: summary(['a']), hasCapability: false })).toEqual({
      kind: 'fail',
      error: NEEDS_RUNNER,
    });
  });
  it('fails a malformed CHANGELOG.md read at the analysed head, before any writing', () => {
    const d = decideChangelogDispatch({
      ...base,
      summary: summary(['a']),
      facts: { headSha: 'h1', changelog: UNDATED },
    });
    expect(d.kind).toBe('fail');
    expect(d.kind === 'fail' && d.error).toContain('## [1.5.0] section without a date');
  });
  it('ignores facts read at another head (the runner re-checks the real file)', () => {
    const d = decideChangelogDispatch({
      ...base,
      summary: summary(['a']),
      facts: { headSha: 'old', changelog: UNDATED },
    });
    expect(d).toEqual({ kind: 'write', uncovered: ['a'] });
  });
  it('sends no entries when every change is covered (second run) or there are none', () => {
    const s = summary(['a', 'b']);
    expect(
      decideChangelogDispatch({
        ...base,
        summary: s,
        facts: { headSha: 'h1', changelog: GOOD },
        covered: new Set(['a', 'b']),
      }),
    ).toEqual({ kind: 'apply', entries: [] });
    expect(decideChangelogDispatch({ ...base, summary: summary([]) })).toEqual({
      kind: 'apply',
      entries: [],
    });
  });
  it('lists the uncovered changes', () => {
    expect(
      decideChangelogDispatch({ ...base, summary: summary(['a', 'b']), covered: new Set(['a']) }),
    ).toEqual({
      kind: 'write',
      uncovered: ['b'],
    });
  });
});

describe('covered sources', () => {
  it('unions added, covered and skipped sources of earlier outputs and the earlier prep commits', () => {
    const s = coveredSourcesOf(
      [
        {
          added: [{ heading: 'Added', text: 'x', sources: ['a', 'b'] }],
          covered: [{ source: 'c', existing: 1 }],
        },
        { skipped: [{ source: 'd', reason: 'internal' }] },
        'not an output',
      ],
      ['prep1'],
    );
    expect([...s].sort()).toEqual(['a', 'b', 'c', 'd', 'prep1']);
    expect(
      summarySources({
        ...summary(['a']),
        merges: [{ sha: 'm', subject: 's', cardKeys: [], prNumber: null }],
      }),
    ).toEqual(['a', 'm']);
  });
});

describe('stored output', () => {
  it('keeps a valid changelog output with the proposal lists, drops an invalid or oversized one', () => {
    const out = storedChangelogOutput(
      { created: true, added: [{ heading: 'Added', text: 'A thing.', sources: ['a'] }] },
      { projectName: 'P', entries: [], proposal: { covered: [{ source: 'c', existing: 2 }], skipped: [] } },
    );
    expect(out).toMatchObject({ created: true, covered: [{ source: 'c', existing: 2 }] });
    expect(storedChangelogOutput({ added: [{ heading: 'Nope', text: 'x' }] }, undefined)).toBeUndefined();
    expect(storedChangelogOutput(undefined, undefined)).toBeUndefined();
    expect(storedStepOutput('guide', { big: 'x'.repeat(70_000) }, undefined)).toBeUndefined();
    expect(storedStepOutput('guide', { ok: 1 }, undefined)).toEqual({ ok: 1 });
  });
});

describe('merged entries reach the release section and the public page unchanged', () => {
  const entries = [
    {
      heading: 'Added' as const,
      text: 'Release prep on the Releases page writes the changelog before a release ships.',
    },
    {
      heading: 'Fixed' as const,
      text: 'The release page no longer drops entries written under an unknown heading.',
    },
  ];
  it('passes publicText and the gate, parses as Unreleased, and is published', () => {
    for (const e of entries) expect(scrubChangelogEntry(e, { publicText })).toEqual([]);
    const merged = mergeUnreleased(GOOD, entries);
    if (merged.kind !== 'merged') throw new Error(merged.kind);
    const un = parseUnreleased(merged.md);
    expect(un?.entries).toBe(2);
    const rel = releaseChangelog(merged.md, { version: '1.5.0', date: '2026-11-05', bumps: [] });
    if (rel.kind !== 'rewritten') throw new Error(rel.kind);
    const parsed = parseChangelog(rel.md);
    expect(parsed[0]?.version).toBe('1.5.0');
    expect(parsed[0]?.sections.added).toEqual([entries[0]?.text]);
    expect(parsed[0]?.sections.fixed).toEqual([entries[1]?.text]);
    expect(typeof buildReleases).toBe('function');
  });
});
