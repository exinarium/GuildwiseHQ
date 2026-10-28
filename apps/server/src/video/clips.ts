import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ClipResolver, ClipScene, ResolvedClip } from '@aom/video';

/** One chapter of a help video: a range of its MP4 in seconds. */
export interface ClipChapter {
  index: number;
  title: string;
  t0: number;
  t1: number;
}

export interface ClipEntry {
  slug: string;
  title: string;
  duration: number;
  mp4: string;
  chapters: ClipChapter[];
}

/** Where the recorded help videos are: AOM_MEDIA_VIDEOS_DIR, or `media/videos` of the checkout. */
export function mediaVideosDir(): string {
  const here = import.meta.dirname;
  const candidates = [
    process.env.AOM_MEDIA_VIDEOS_DIR,
    resolve(here, '../../../../media/videos'),
    resolve(here, '../../../media/videos'),
    resolve(process.cwd(), 'media/videos'),
    resolve(process.cwd(), '../../media/videos'),
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error('media/videos not found (set AOM_MEDIA_VIDEOS_DIR)');
  return found;
}

interface ManifestJson {
  title?: string;
  duration?: number;
  chapters?: Array<{ t: number; title: string }>;
}

/** Every help video that has both an MP4 and a chapters JSON. Chapter k runs from its time to the next one's (or the end). */
export function loadClipCatalog(dir: string = mediaVideosDir()): ClipEntry[] {
  const entries: ClipEntry[] = [];
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.json'))
    .sort()) {
    const slug = f.slice(0, -5);
    const mp4 = join(dir, `${slug}.mp4`);
    if (!existsSync(mp4)) continue;
    let json: ManifestJson;
    try {
      json = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ManifestJson;
    } catch {
      continue;
    }
    const duration = json.duration ?? 0;
    const ch = json.chapters ?? [];
    entries.push({
      slug,
      title: json.title ?? slug,
      duration,
      mp4,
      chapters: ch.map((c, i) => ({ index: i, title: c.title, t0: c.t, t1: ch[i + 1]?.t ?? duration })),
    });
  }
  return entries;
}

/** A flat list the script writer is shown: which clips it may use. */
export function clipCatalogForPrompt(
  catalog: ClipEntry[],
): Array<{ slug: string; chapter: number; title: string; t0: number; t1: number }> {
  return catalog.flatMap((e) =>
    e.chapters.map((c) => ({
      slug: e.slug,
      chapter: c.index,
      title: `${e.title}: ${c.title}`,
      t0: c.t0,
      t1: c.t1,
    })),
  );
}

/** Turns clip scenes into a range of a help video MP4. Throws on an unknown video or chapter. */
export function clipResolver(catalog: ClipEntry[]): ClipResolver {
  const bySlug = new Map(catalog.map((e) => [e.slug, e]));
  return (scene: ClipScene): ResolvedClip => {
    const e = bySlug.get(scene.slug);
    if (!e) throw new Error(`unknown help video "${scene.slug}"`);
    if (scene.chapter !== undefined) {
      const ch =
        typeof scene.chapter === 'number'
          ? e.chapters[scene.chapter]
          : e.chapters.find((c) => c.title.toLowerCase() === String(scene.chapter).toLowerCase());
      if (!ch) throw new Error(`help video "${scene.slug}" has no chapter ${scene.chapter}`);
      return { file: e.mp4, from: ch.t0, to: ch.t1, title: `${e.title}: ${ch.title}` };
    }
    const from = scene.from ?? 0;
    const to = scene.to ?? from;
    if (e.duration && from >= e.duration) throw new Error(`clip starts after the end of "${scene.slug}"`);
    return { file: e.mp4, from, to: e.duration ? Math.min(to, e.duration) : to, title: e.title };
  };
}
