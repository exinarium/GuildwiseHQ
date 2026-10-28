import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocialCaptionsSchema, SocialPostContentSchema } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildReleases,
  draftFromRelease,
  loadReleases,
  locateReleaseSource,
  parseChangelog,
  parseWhatsNew,
  publicText,
  resetReleaseWarnings,
  useReleaseSource,
  type WhatsNewSource,
  whatsNewFor,
} from '../src/blog/releases.ts';

export const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Added

- Not released yet.

## [1.2.0] - 2026-10-28

Runner 0.1.63.

### Added

- Release posts: each release can be announced on the connected networks (see
  /help/blog-and-digest), thanks @octocat (#412).
- Hashtags per network.

### Changed

- The [blog page](/help/blog-and-digest) is clearer.

### Removed

- The old caption box.

### Security

- Tightened a check.

## [1.1.0] - 2026-10-27

### Fixed

- A crash on start.

## [1.0.0] - 2026-09-01

### Added

- First release.
`;

const entry = (over: Partial<WhatsNewSource>): WhatsNewSource => ({
  id: 'e',
  title: 'T',
  date: '2026-10-28',
  audience: 'all',
  body: 'Body',
  ...over,
});

describe('parseChangelog', () => {
  const rs = parseChangelog(CHANGELOG);
  it('reads the dated releases, newest first, and leaves Unreleased out', () => {
    expect(rs.map((r) => [r.version, r.date])).toEqual([
      ['1.2.0', '2026-10-28'],
      ['1.1.0', '2026-10-27'],
      ['1.0.0', '2026-09-01'],
    ]);
  });
  it('sorts items into added, changed and fixed, joining wrapped lines', () => {
    const r = rs[0];
    expect(r?.intro).toBe('Runner 0.1.63.');
    expect(r?.sections.added).toHaveLength(2);
    expect(r?.sections.added[0]).toContain('(see /help/blog-and-digest), thanks @octocat (#412).');
    expect(r?.sections.changed).toEqual([
      'The [blog page](/help/blog-and-digest) is clearer.',
      'The old caption box.',
    ]);
    expect(r?.sections.fixed).toEqual(['Tightened a check.']);
    expect(rs[1]?.sections.fixed).toEqual(['A crash on start.']);
  });
  it('reads the real CHANGELOG of the repository', () => {
    const real = loadReleases();
    expect(real.length).toBeGreaterThan(0);
    expect(real[0]?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(real[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('publicText', () => {
  it('strips handles, issue numbers and Help links', () => {
    expect(publicText('Release posts (see /help/blog-and-digest), thanks @octocat (#412).')).toBe(
      'Release posts, thanks.',
    );
    expect(publicText('The [blog page](/help/blog-and-digest) is clearer #12')).toBe(
      'The blog page is clearer',
    );
    expect(publicText('Mail me at a@b.co and see [docs](https://x.test/@y)')).toBe(
      'Mail me at a@b.co and see [docs](https://x.test/@y)',
    );
  });
});

describe('whatsNewFor', () => {
  const release = { version: '1.2.0', date: '2026-10-28' };
  it('takes the entries after the previous release up to and including this one', () => {
    const got = whatsNewFor(release, '2026-10-27', [
      entry({ id: 'on-day', date: '2026-10-28' }),
      entry({ id: 'prev-day', date: '2026-10-27' }),
      entry({ id: 'later', date: '2026-10-29' }),
    ]);
    expect(got.map((e) => e.id)).toEqual(['on-day']);
  });
  it('lets the release frontmatter win over the date, both ways', () => {
    const got = whatsNewFor(release, '2026-10-27', [
      entry({ id: 'pinned-here', date: '2026-09-01', release: '1.2.0' }),
      entry({ id: 'pinned-away', date: '2026-10-28', release: '1.3.0' }),
    ]);
    expect(got.map((e) => e.id)).toEqual(['pinned-here']);
  });
  it('keeps only the public audiences and cleans the text', () => {
    const got = whatsNewFor(release, '2026-10-27', [
      entry({ id: 'a', audience: 'superadmin' }),
      entry({ id: 'b', audience: 'owner', body: 'Thanks @someone (#9). See /help/x' }),
      entry({ id: 'c', audience: 'admin' }),
    ]);
    expect(got.map((e) => e.id)).toEqual(['b', 'c']);
    expect(got[0]?.body).toBe('Thanks.');
  });
  it('without a previous release uses the 14 days before', () => {
    const got = whatsNewFor(release, null, [
      entry({ id: 'near', date: '2026-10-20' }),
      entry({ id: 'far', date: '2026-09-01' }),
    ]);
    expect(got.map((e) => e.id)).toEqual(['near']);
  });
});

describe('parseWhatsNew', () => {
  it('reads the optional release and ignores a malformed one', () => {
    const md = (rel: string) => `---\ntitle: X\ndate: 2026-10-28\naudience: all\nrelease: ${rel}\n---\nBody`;
    expect(parseWhatsNew('x', md('1.2.0')).release).toBe('1.2.0');
    expect(parseWhatsNew('x', md('soon')).release).toBeUndefined();
  });
});

describe('manifest files', () => {
  let dir: string;
  afterEach(() => {
    useReleaseSource(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  it('loads the changelog and the entries from a directory and builds the manifest', () => {
    dir = mkdtempSync(join(tmpdir(), 'rel-'));
    mkdirSync(join(dir, 'entries'));
    writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG);
    writeFileSync(
      join(dir, 'entries', '2026-10-28-a.md'),
      '---\ntitle: Release posts\ndate: 2026-10-28\naudience: all\n---\nAnnounce each release.',
    );
    writeFileSync(join(dir, 'entries', 'README.md'), 'not an entry');
    useReleaseSource({ changelogPath: join(dir, 'CHANGELOG.md'), entriesDir: join(dir, 'entries') });
    const rs = loadReleases();
    expect(rs.map((r) => r.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(rs[0]?.whatsNew.map((w) => w.title)).toEqual(['Release posts']);
    expect(rs[0]?.sections.added[0]).toBe(
      'Release posts: each release can be announced on the connected networks, thanks.',
    );
    expect(rs[1]?.whatsNew).toEqual([]);
  });
  it('is empty, and logs once, when the changelog path is not a regular file (a directory left by a build)', () => {
    dir = mkdtempSync(join(tmpdir(), 'rel-'));
    mkdirSync(join(dir, 'CHANGELOG.md')); // the directory tsup's onSuccess runner once left in its place
    mkdirSync(join(dir, 'entries'));
    useReleaseSource({ changelogPath: join(dir, 'CHANGELOG.md'), entriesDir: join(dir, 'entries') });
    resetReleaseWarnings();
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    try {
      expect(loadReleases()).toEqual([]); // no EISDIR
      useReleaseSource({ changelogPath: join(dir, 'CHANGELOG.md'), entriesDir: join(dir, 'entries') }); // clears the cache
      expect(loadReleases()).toEqual([]);
    } finally {
      console.error = orig;
    }
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain('not a regular file');
  });
  it('is empty when the files are missing', () => {
    useReleaseSource({ changelogPath: '/nonexistent/CHANGELOG.md', entriesDir: '/nonexistent' });
    expect(loadReleases()).toEqual([]);
  });
});

describe('where the files are', () => {
  let base: string;
  afterEach(() => {
    useReleaseSource(null);
    if (base) rmSync(base, { recursive: true, force: true });
  });
  it('finds the bundled dist/release-notes layout first and calls it immutable', () => {
    base = mkdtempSync(join(tmpdir(), 'dist-'));
    mkdirSync(join(base, 'release-notes', 'whats-new'), { recursive: true });
    writeFileSync(join(base, 'release-notes', 'CHANGELOG.md'), CHANGELOG);
    writeFileSync(
      join(base, 'release-notes', 'whats-new', '2026-10-28-a.md'),
      '---\ntitle: Bundled\ndate: 2026-10-28\naudience: all\n---\nBody',
    );
    const found = locateReleaseSource(base);
    expect(found?.bundled).toBe(true);
    expect(found?.source.entriesDir).toBe(join(base, 'release-notes', 'whats-new'));
  });
  it('returns null when neither the bundle nor the repository files are there', () => {
    base = mkdtempSync(join(tmpdir(), 'nowhere-'));
    expect(locateReleaseSource(join(base, 'a', 'b', 'c', 'd', 'e'))).toBeNull();
  });
  it('re-reads a source file only after a few seconds (not on every page request)', () => {
    base = mkdtempSync(join(tmpdir(), 'cache-'));
    writeFileSync(join(base, 'CHANGELOG.md'), CHANGELOG);
    useReleaseSource({ changelogPath: join(base, 'CHANGELOG.md'), entriesDir: join(base, 'none') });
    expect(loadReleases()).toHaveLength(3);
    writeFileSync(join(base, 'CHANGELOG.md'), '# Changelog\n');
    expect(loadReleases()).toHaveLength(3); // served from memory
    useReleaseSource({ changelogPath: join(base, 'CHANGELOG.md'), entriesDir: join(base, 'none') });
    expect(loadReleases()).toHaveLength(0); // a new source is read at once
  });
});

describe('draftFromRelease', () => {
  it('prefills a valid post, factual and without a link', () => {
    const [r] = buildReleases(CHANGELOG, []);
    if (!r) throw new Error('no release');
    const c = draftFromRelease(r);
    expect(SocialPostContentSchema.safeParse(c).success).toBe(true);
    expect(SocialCaptionsSchema.safeParse(c.captions).success).toBe(true);
    expect(c.version).toBe('1.2.0');
    expect(c.title).toContain('1.2.0');
    expect(JSON.stringify(c)).not.toMatch(/https?:\/\//);
    expect(JSON.stringify(c)).not.toContain('@octocat');
  });
  it('keeps the LinkedIn text within its limit on whole lines', () => {
    const long = 'x'.repeat(100);
    const c = draftFromRelease({
      version: '1.2.0',
      date: '2026-10-28',
      intro: '',
      sections: {
        added: [1, 2, 3, 4, 5, 6].map((n) => `${long} number ${n} ${long}.`),
        changed: [],
        fixed: [],
      },
      whatsNew: [],
    });
    const li = c.captions.linkedinText ?? '';
    expect(li.length).toBeLessThanOrEqual(700);
    expect(li.endsWith('The full list is on the release page.')).toBe(true);
    expect(
      li
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .every((l) => l.endsWith('…') || l.length > 10),
    ).toBe(true);
  });
  it('is still valid for a release with nothing listed', () => {
    const c = draftFromRelease({
      version: '9.9.9',
      date: '2026-10-28',
      intro: '',
      sections: { added: [], changed: [], fixed: [] },
      whatsNew: [],
    });
    expect(SocialPostContentSchema.safeParse(c).success).toBe(true);
  });
});
