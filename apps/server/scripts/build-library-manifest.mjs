// Writes dist/video-library.json from media/videos/*.json: the slugs, titles, durations and chapters of the help videos,
// so the app (whose image has no MP4s) can list and import them. Usage: node scripts/build-library-manifest.mjs [<media/videos> <out.json>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// no arguments: media/videos of the repository -> apps/server/dist/video-library.json
const here = dirname(fileURLToPath(import.meta.url));
const [dirArg, outArg] = process.argv.slice(2);
const dir = dirArg ?? resolve(here, '../../../media/videos');
const out = outArg ?? resolve(here, '../dist/video-library.json');
const videos = [];
if (dir && existsSync(dir)) {
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.json'))
    .sort()) {
    const slug = f.slice(0, -5);
    if (!existsSync(join(dir, `${slug}.mp4`))) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      videos.push({
        slug,
        title: j.title ?? slug,
        duration: j.duration ?? 0,
        vtt: existsSync(join(dir, `${slug}.vtt`)),
        chapters: (j.chapters ?? []).map((c) => ({ t: c.t, title: c.title })),
      });
    } catch {
      // an unreadable manifest is skipped, like the clip catalog does
    }
  }
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ videos }));
console.log(`video library manifest: ${videos.length} videos`);
