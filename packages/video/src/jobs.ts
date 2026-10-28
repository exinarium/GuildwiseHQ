import { join } from 'node:path';
import type { VideoScript } from '@aom/shared';
import type { PngJob } from './browser.ts';
import type { ClipResolver, ResolvedClip } from './render.ts';
import {
  clipFrameHtml,
  type Orientation,
  type SceneImages,
  SIZES,
  sceneHtml,
  THUMB_SIZE,
  thumbnailHtml,
} from './scenes.ts';
import type { Timeline } from './timeline.ts';

export interface SceneJob {
  png: PngJob;
  clip?: ResolvedClip;
}

/** One picture job per timeline segment (a branded frame for clips, a scene card otherwise). */
export async function browserJobsFor(
  tl: Timeline,
  orient: Orientation,
  work: string,
  images: SceneImages | undefined,
  clips: ClipResolver | undefined,
): Promise<SceneJob[]> {
  const { width, height } = SIZES[orient];
  const jobs: SceneJob[] = [];
  for (const [i, seg] of tl.segments.entries()) {
    const out = join(work, `scene-${String(i).padStart(3, '0')}.png`);
    if (seg.scene.type === 'clip') {
      if (!clips) throw new Error('the script has clip scenes but no clip resolver was given');
      const clip = await clips(seg.scene);
      jobs.push({ png: { html: clipFrameHtml(orient, clip.title), width, height, out }, clip });
    } else jobs.push({ png: { html: sceneHtml(seg.scene, orient, images), width, height, out } });
  }
  return jobs;
}

const KICKER = { article: 'New article', release: "What's new", tutorial: 'Tutorial' } as const;

export function thumbnailJob(script: VideoScript, out: string): PngJob {
  return { html: thumbnailHtml(script.title, KICKER[script.kind]), out, ...THUMB_SIZE };
}
