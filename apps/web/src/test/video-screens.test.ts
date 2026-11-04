import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { VideoScreenMapSchema, videoGlobMatches } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { SECTION_VIDEOS } from '../lib/videos.ts';

/**
 * Keeps e2e/video/screens.json (the map the release prep 'Generate videos' step uses to choose the videos to re-render)
 * complete: a feature that adds a page fails here until the page is mapped to a video, planned or excluded.
 */
const ROOT = join(__dirname, '../../../..');
const map = VideoScreenMapSchema.parse(
  JSON.parse(readFileSync(join(ROOT, 'e2e/video/screens.json'), 'utf8')),
);

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [relative(ROOT, join(dir, e.name)).split('\\').join('/')],
  );
const webFiles = walk(join(ROOT, 'apps/web/src'));
const specs = readdirSync(join(ROOT, 'e2e/video'))
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => f.replace(/\.spec\.ts$/, ''))
  .sort();
const any = (globs: string[], path: string) => videoGlobMatches(globs, path);

describe('e2e/video/screens.json', () => {
  it('has an entry for every video spec, and a spec for every entry', () => {
    expect(Object.keys(map.videos).sort()).toEqual(specs);
  });

  it('maps every published help video, and plans every unpublished one', () => {
    for (const [slug, v] of Object.entries(SECTION_VIDEOS)) {
      if (v.published) expect(map.videos[slug], slug).toBeDefined();
      else expect(map.planned[slug], slug).toBeDefined();
    }
  });

  it('has globs that each match at least one file', () => {
    const globs = [
      ...map.pages,
      ...map.exclude,
      ...Object.values(map.videos).flatMap((v) => v.screens.flatMap((s) => s.files)),
      ...Object.values(map.planned).flatMap((p) => p.pages),
    ];
    for (const g of globs)
      expect(
        webFiles.some((f) => videoGlobMatches([g], f)),
        g,
      ).toBe(true);
  });

  it('puts every page in a video, in planned or in exclude', () => {
    const covered = [
      ...Object.values(map.videos).flatMap((v) => v.screens.flatMap((s) => s.files)),
      ...Object.values(map.planned).flatMap((p) => p.pages),
      ...map.exclude,
    ];
    const pages = webFiles.filter((f) => any(map.pages, f) && !any(['**/*.test.*'], f));
    expect(pages.length).toBeGreaterThan(10);
    for (const p of pages) expect(any(covered, p), p).toBe(true);
  });
});
