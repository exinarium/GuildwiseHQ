#!/usr/bin/env node
// Builds videos/manifest.json for the media image: slug -> files (with sha256 and size), captions, poster and duration.
//   node build-manifest.mjs [videosDir]          writes <videosDir>/manifest.json
//   node build-manifest.mjs [videosDir] --hash   prints the content hash only (what the image is labelled with)
// Deterministic: sorted, no timestamps. The content hash covers every file except manifest.json itself.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const hashOnly = args.includes('--hash');
const dir = resolve(
  args.find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), 'videos'),
);

const TYPES = {
  webm: 'video/webm',
  mp4: 'video/mp4',
  vtt: 'text/vtt',
  json: 'application/json',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const names = readdirSync(dir)
  .filter((n) => n !== 'manifest.json' && !n.startsWith('.'))
  .sort();
const files = names.map((name) => {
  const buf = readFileSync(join(dir, name));
  return { name, sha256: sha(buf), bytes: buf.length, buf };
});

const hash = sha(files.map((f) => `${f.name} ${f.sha256}\n`).join(''));
if (hashOnly) {
  process.stdout.write(`${hash}\n`);
  process.exit(0);
}

const videos = {};
for (const f of files) {
  const m = /^(.+)\.(webm|mp4|vtt|json|jpg|png|webp)$/.exec(f.name);
  if (!m) continue;
  const [, slug, ext] = m;
  videos[slug] ??= { files: {} };
  const v = videos[slug];
  const entry = { path: `/videos/${f.name}`, sha256: f.sha256, bytes: f.bytes, type: TYPES[ext] };
  if (ext === 'json') {
    v.info = entry;
    try {
      const info = JSON.parse(f.buf.toString('utf8'));
      if (typeof info.duration === 'number') v.duration = info.duration;
      if (typeof info.title === 'string') v.title = info.title;
    } catch {
      // an unreadable description simply has no duration
    }
  } else if (ext === 'vtt') v.captions = entry;
  else if (ext === 'jpg' || ext === 'png' || ext === 'webp') v.poster = entry;
  else v.files[ext] = entry;
}
// A video is listed only when it can be played: at least one encoding and its description.
for (const slug of Object.keys(videos))
  if (!Object.keys(videos[slug].files).length || !videos[slug].info) delete videos[slug];

const sorted = Object.fromEntries(
  Object.keys(videos)
    .sort()
    .map((k) => [k, videos[k]]),
);
writeFileSync(
  join(dir, 'manifest.json'),
  `${JSON.stringify({ version: 1, hash, videos: sorted }, null, 2)}\n`,
);
console.log(`manifest.json: ${Object.keys(sorted).length} videos, hash ${hash}`);
