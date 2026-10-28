import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadClipCatalog, mediaVideosDir } from './clips.ts';

/**
 * The catalog of the recorded help videos as the APP sees it. The app image carries no MP4s (they live in the media image
 * and, for the worker, in /opt/media-videos), only a small manifest generated at build from `media/videos/*.json`
 * (`scripts/build-library-manifest.mjs`, written to `dist/video-library.json`). A library post stores the marker
 * `lib:<slug>` as its artifact and the WORKER resolves it to the real file with `libraryFile`.
 *
 * Where the catalog comes from, first hit wins: `AOM_VIDEO_LIBRARY_MANIFEST` (a manifest file), the folder of help videos
 * (development, the worker), the manifest beside the bundle.
 */
export interface LibraryChapter {
  index: number;
  title: string;
  t0: number;
  t1: number;
}
export interface LibraryEntry {
  slug: string;
  title: string;
  duration: number;
  /** A WebVTT caption file exists next to the MP4. */
  vtt: boolean;
  chapters: LibraryChapter[];
}

interface ManifestFile {
  videos: Array<{
    slug: string;
    title: string;
    duration: number;
    vtt?: boolean;
    chapters: Array<{ t: number; title: string }>;
  }>;
}

function fromManifest(file: string): LibraryEntry[] {
  const m = JSON.parse(readFileSync(file, 'utf8')) as ManifestFile;
  return m.videos.map((v) => ({
    slug: v.slug,
    title: v.title,
    duration: v.duration,
    vtt: v.vtt ?? false,
    chapters: v.chapters.map((c, i) => ({
      index: i,
      title: c.title,
      t0: c.t,
      t1: v.chapters[i + 1]?.t ?? v.duration,
    })),
  }));
}

function bundledManifest(): string | null {
  const here = import.meta.dirname;
  return (
    [
      join(here, 'video-library.json'),
      resolve(here, '../dist/video-library.json'),
      resolve(here, '../../dist/video-library.json'),
    ].find(existsSync) ?? null
  );
}

/** The help videos known to this process; empty when there is neither a manifest nor a media folder. */
export function libraryCatalog(): LibraryEntry[] {
  const env = process.env.AOM_VIDEO_LIBRARY_MANIFEST;
  if (env && existsSync(env)) return fromManifest(env);
  try {
    return loadClipCatalog().map((e) => ({
      slug: e.slug,
      title: e.title,
      duration: e.duration,
      vtt: existsSync(e.mp4.replace(/\.mp4$/, '.vtt')),
      chapters: e.chapters,
    }));
  } catch {
    // no media folder here (the app image): the manifest generated at build
  }
  const b = bundledManifest();
  return b ? fromManifest(b) : [];
}

export const LIBRARY_MARKER = 'lib:';

/** The file a `lib:<slug>` marker means on THIS machine (the worker has the media folder), or null. */
export function libraryFile(marker: string, ext: 'mp4' | 'vtt'): string | null {
  if (!marker.startsWith(LIBRARY_MARKER)) return null;
  const slug = marker.slice(LIBRARY_MARKER.length);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  try {
    const f = join(mediaVideosDir(), `${slug}.${ext}`);
    return existsSync(f) ? f : null;
  } catch {
    return null;
  }
}
