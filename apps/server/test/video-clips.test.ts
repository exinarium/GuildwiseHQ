import { readFileSync } from 'node:fs';
import { parseVideoScript } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { clipCatalogForPrompt, clipResolver, loadClipCatalog } from '../src/video/clips.ts';

const catalog = loadClipCatalog();
const publishedSlugs = [
  ...readFileSync(new URL('../../web/src/lib/videos.ts', import.meta.url), 'utf8').matchAll(
    /^ {2}(?:\[(\w+)\]|'?([\w-]+)'?): \{\n(?:(?! {2}\},)[^\n]*\n)*? {4}published: true/gm,
  ),
].map((m) =>
  m[1] === 'OVERVIEW_SLUG'
    ? 'overview'
    : m[1] === 'GETTING_STARTED_SLUG'
      ? 'getting-started'
      : ((m[2] ?? m[1]) as string),
);

describe('help video clips', () => {
  it('lists every recorded help video with chapters that tile the video', () => {
    expect(catalog.length).toBeGreaterThan(20);
    const agents = catalog.find((c) => c.slug === 'agents');
    expect(agents?.chapters[0]).toMatchObject({ index: 0, title: 'Hire an agent', t0: 10.3, t1: 29.1 });
    expect(agents?.chapters.at(-1)?.t1).toBe(agents?.duration);
    expect(clipCatalogForPrompt(catalog).length).toBeGreaterThan(50);
  });
  it('knows the published videos of apps/web/src/lib/videos.ts', () => {
    expect(publishedSlugs.length).toBeGreaterThan(20);
    for (const slug of publishedSlugs)
      expect(
        catalog.map((c) => c.slug),
        slug,
      ).toContain(slug);
  });
  it('resolves chapters by index or title and ranges, and rejects unknown ones', () => {
    const r = clipResolver(catalog);
    expect(r({ type: 'clip', slug: 'agents', chapter: 1 })).toMatchObject({ from: 29.1, to: 44.6 });
    expect(r({ type: 'clip', slug: 'agents', chapter: 'recommendations' })).toMatchObject({ from: 44.6 });
    expect(r({ type: 'clip', slug: 'agents', from: 5, to: 9 })).toMatchObject({ from: 5, to: 9 });
    expect(() => r({ type: 'clip', slug: 'nope', chapter: 0 })).toThrow(/unknown help video/);
    expect(() => r({ type: 'clip', slug: 'agents', chapter: 99 })).toThrow(/no chapter/);
  });
  it('validates a fixture script against the real catalog', () => {
    const s = JSON.parse(
      readFileSync(
        new URL('../../../packages/video/test/fixtures/agents-long.json', import.meta.url),
        'utf8',
      ),
    );
    expect(parseVideoScript(s, { clipSlugs: catalog.map((c) => c.slug) }).ok).toBe(true);
    const bad = {
      ...s,
      cues: s.cues.map((c: { scene: { type: string } }, i: number) =>
        i === 2 ? { ...c, scene: { type: 'clip', slug: 'zzz', chapter: 0 } } : c,
      ),
    };
    expect(parseVideoScript(bad, { clipSlugs: catalog.map((c) => c.slug) }).ok).toBe(false);
  });
});
