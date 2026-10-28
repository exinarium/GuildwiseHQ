import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseVideoScript, type VideoScript } from '@aom/shared';
import { type RenderOptions, type RenderResult, renderVideo } from '@aom/video';
import { type ClipEntry, clipResolver, loadClipCatalog } from './clips.ts';

export interface RenderScriptOptions extends Omit<RenderOptions, 'clips'> {
  /** Defaults to the help videos of the checkout (media/videos). */
  catalog?: ClipEntry[];
  /** Directory with cover pictures (`<name>.png`), for image scenes of kind cover. */
  coverDir?: string;
  coverName?: string;
}

function coverImage(opts: RenderScriptOptions): string | undefined {
  const dir =
    opts.coverDir ??
    [
      resolve(import.meta.dirname, '../../../web/public/blog/cover'),
      resolve(import.meta.dirname, '../../../../apps/web/public/blog/cover'),
    ].find(existsSync);
  if (!dir || !opts.coverName) return undefined;
  const f = join(dir, `${opts.coverName}.png`);
  return existsSync(f) ? f : undefined;
}

/**
 * What the review flow (V2) and the worker loop call: validates the script against the help video catalog, then
 * renders it. Returns the artifacts (video, captions, thumbnail, description, script, log) in `opts.outDir`.
 */
export async function renderScript(script: unknown, opts: RenderScriptOptions): Promise<RenderResult> {
  const catalog = opts.catalog ?? loadClipCatalog();
  const parsed = parseVideoScript(script, { clipSlugs: catalog.map((c) => c.slug) });
  if (!parsed.ok) throw new Error(`invalid video script:\n- ${parsed.issues.join('\n- ')}`);
  const s: VideoScript = parsed.script;
  const cover = coverImage(opts);
  return renderVideo(s, {
    ...opts,
    clips: clipResolver(catalog),
    images: { ...opts.images, cover: opts.images?.cover ?? cover },
  });
}

/** Renders the script in a JSON file. */
export async function renderScriptFile(file: string, opts: RenderScriptOptions): Promise<RenderResult> {
  return renderScript(JSON.parse(readFileSync(file, 'utf8')), opts);
}
