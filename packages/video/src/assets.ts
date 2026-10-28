import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the package's static files live (templates, kokoro-say.py, the logo): next to the source
 * (packages/video/assets), or `video-assets` beside a bundle such as dist/video-worker.mjs. AOM_VIDEO_ASSETS wins.
 */
export function assetsDir(): string {
  const here = import.meta.dirname;
  const candidates = [process.env.AOM_VIDEO_ASSETS, join(here, '../assets'), join(here, 'video-assets')];
  for (const c of candidates) if (c && existsSync(join(c, 'kokoro-say.py'))) return c;
  throw new Error(`video assets not found (looked in ${candidates.filter(Boolean).join(', ')})`);
}

export function assetPath(...parts: string[]): string {
  // resolved lazily: importing the package must not fail where nothing is rendered
  return join(assetsDirOrGuess(), ...parts);
}

function assetsDirOrGuess(): string {
  try {
    return assetsDir();
  } catch {
    return join(import.meta.dirname, '../assets');
  }
}
