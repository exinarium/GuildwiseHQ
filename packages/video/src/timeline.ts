import { VIDEO_LIMITS, type VideoScene, type VideoScript } from '@aom/shared';

/** Seconds of cross fade between two scenes; it happens inside the silence after a cue. */
export const XFADE_SECONDS = 0.3;
/** Slowest a short help clip is played before its last frame is frozen. */
export const MIN_CLIP_SPEED = 0.8;

export interface TimelineCue {
  id: string;
  text: string;
  start: number;
  /** End of the spoken audio (the gap follows). */
  end: number;
}

export interface TimelineSegment {
  scene: VideoScene;
  /** Index of the first cue shown in this scene and how many cues it covers. */
  firstCue: number;
  cueCount: number;
  start: number;
  /** Length on screen in the cut, gap included. */
  duration: number;
}

export interface Timeline {
  cues: TimelineCue[];
  segments: TimelineSegment[];
  chapters: Array<{ title: string; start: number }>;
  /** Sum of the cue audio and the gaps. */
  total: number;
}

const same = (a: VideoScene, b: VideoScene) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Cue i starts when the cues before it, each with its gap, are done. Consecutive cues with the same scene share one
 * segment. `durations[i]` is the audio length of cue i.
 */
export function buildTimeline(
  script: Pick<VideoScript, 'cues' | 'chapters'>,
  durations: number[],
  gap: number = VIDEO_LIMITS.cueGapSeconds,
): Timeline {
  const cues: TimelineCue[] = [];
  const segments: TimelineSegment[] = [];
  let t = 0;
  script.cues.forEach((c, i) => {
    const d = durations[i];
    if (d === undefined) throw new Error(`no audio length for cue ${c.id}`);
    cues.push({ id: c.id, text: c.text, start: t, end: t + d });
    const last = segments[segments.length - 1];
    if (last && same(last.scene, c.scene)) {
      last.cueCount += 1;
      last.duration += d + gap;
    } else segments.push({ scene: c.scene, firstCue: i, cueCount: 1, start: t, duration: d + gap });
    t += d + gap;
  });
  const chapters = script.chapters.map((ch) => ({ title: ch.title, start: cues[ch.fromCue]?.start ?? 0 }));
  return { cues, segments, chapters, total: t };
}

/**
 * Length of each segment's video stream so that, with an `xfade` of XFADE_SECONDS between neighbours, the cut is
 * exactly `total` long and transition k finishes where segment k begins: every segment after the first is extended
 * by the overlap at its head.
 */
export function streamDurations(t: Timeline): number[] {
  return t.segments.map((s, i) => s.duration + (i === 0 ? 0 : XFADE_SECONDS));
}

/** xfade offsets (seconds into the combined stream) for `streamDurations`. */
export function xfadeOffsets(t: Timeline): number[] {
  return t.segments.slice(1).map((s) => s.start - XFADE_SECONDS);
}

export interface ClipFit {
  /** Playback speed (1 = normal, never below MIN_CLIP_SPEED). */
  speed: number;
  /** Seconds of source taken, from the start of the range. */
  take: number;
  /** Seconds the last frame is held after the clip has played out. */
  freeze: number;
}

/** Fits a source range of `source` seconds into a scene of `target` seconds: trim, or slow down, then freeze. */
export function fitClip(target: number, source: number): ClipFit {
  if (source >= target) return { speed: 1, take: target, freeze: 0 };
  const speed = Math.max(MIN_CLIP_SPEED, source / target);
  return { speed, take: source, freeze: Math.max(0, target - source / speed) };
}
