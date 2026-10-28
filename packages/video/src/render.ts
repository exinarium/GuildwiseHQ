import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDescription,
  speakable,
  VIDEO_LIMITS,
  type VideoScene,
  type VideoScript,
  VideoScriptSchema,
} from '@aom/shared';
import { joinWavs, writeSilentWav } from './audio.ts';
import { renderPngs } from './browser.ts';
import { ass, chunkCaption, srt } from './captions.ts';
import { findFfmpeg, probeDuration, RENDER_ENCODERS, runFfmpeg, vtt } from './ffmpeg.ts';
import { browserJobsFor, type SceneJob, thumbnailJob } from './jobs.ts';
import { clipBox, type Orientation, type SceneImages, SIZES } from './scenes.ts';
import {
  buildTimeline,
  fitClip,
  streamDurations,
  type Timeline,
  XFADE_SECONDS,
  xfadeOffsets,
} from './timeline.ts';
import { type Spoken, speak, VOICE_LABEL, voiceAvailable } from './voice.ts';

export type ClipScene = Extract<VideoScene, { type: 'clip' }>;

/** A range of a help video (MP4 file, seconds) a clip scene resolved to. */
export interface ResolvedClip {
  file: string;
  from: number;
  to: number;
  /** Shown in the strip above the clip. */
  title: string;
}

export type ClipResolver = (scene: ClipScene) => ResolvedClip | Promise<ResolvedClip>;

export interface RenderOptions {
  /** Where the artifacts go (created). */
  outDir: string;
  /** Scratch space for PNGs and segments; default `<outDir>/.work`, removed afterwards unless keepWork. */
  workDir?: string;
  keepWork?: boolean;
  /** Resolves clip scenes; without it a script with clips cannot be rendered. */
  clips?: ClipResolver;
  images?: SceneImages;
  /** Speak silence instead of failing when the Kokoro voice is not installed (smoke tests only). */
  silentFallback?: boolean;
  crf?: number;
  fps?: number;
  log?: (line: string) => void;
}

export interface RenderArtifacts {
  video: string;
  captionsVtt: string;
  captionsSrt: string;
  thumb: string | null;
  script: string;
  description: string;
  log: string;
}

export interface RenderResult {
  artifacts: RenderArtifacts;
  /** The YouTube description text (also in artifacts.description). */
  descriptionText: string;
  durationSeconds: number;
  bytes: number;
  width: number;
  height: number;
  timeline: Timeline;
  /** Speech was synthesized with this voice, or 'silent placeholder'. */
  voice: string;
  /** Seconds the render took. */
  renderSeconds: number;
}

const WORDS_PER_SECOND = 2.4;

/**
 * Renders a script to a finished MP4 plus captions, thumbnail (long videos), description and render log:
 * speak every cue, cut the scenes to the audio, cross fade, encode H.264/AAC with fast start. Shorts are
 * 1080x1920 with big burned-in captions.
 */
export async function renderVideo(input: VideoScript, opts: RenderOptions): Promise<RenderResult> {
  const started = Date.now();
  const script = VideoScriptSchema.parse(input);
  const short = script.format === 'short';
  const orient: Orientation = short ? 'portrait' : 'landscape';
  const { width, height } = SIZES[orient];
  const fps = opts.fps ?? 30;
  const lines: string[] = [];
  const log = (m: string) => {
    const line = `[${((Date.now() - started) / 1000).toFixed(1)}s] ${m}`;
    lines.push(line);
    opts.log?.(line);
  };
  const out = opts.outDir;
  const work = opts.workDir ?? join(out, '.work');
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  const ff = findFfmpeg(RENDER_ENCODERS);

  // 1. speech
  const cues = script.cues.map((c) => ({ id: c.id, text: c.text, speech: c.speech ?? speakable(c.text) }));
  let spoken: Spoken[];
  let voice = VOICE_LABEL;
  if (voiceAvailable()) {
    log(`speaking ${cues.length} cues (${VOICE_LABEL})`);
    spoken = speak(cues);
  } else if (opts.silentFallback) {
    voice = 'silent placeholder';
    log('voice not installed: silent placeholder audio');
    spoken = cues.map((c) => {
      const file = join(work, `silence-${c.id}.wav`);
      const seconds = c.text.split(/\s+/).length / WORDS_PER_SECOND + 0.3;
      writeSilentWav(file, seconds);
      return { id: c.id, file, duration: Math.round(seconds * 24000) / 24000 };
    });
  } else
    throw new Error(
      'the voice is not installed (run e2e/video/setup-voice.sh) and no silent fallback was asked for',
    );

  // 2. timeline
  const tl = buildTimeline(
    script,
    spoken.map((s) => s.duration),
  );
  log(`timeline: ${tl.segments.length} scenes, ${tl.total.toFixed(1)}s`);
  const maxSeconds = VIDEO_LIMITS.maxSeconds[script.format];
  if (tl.total > maxSeconds)
    throw new Error(`the video would be ${Math.round(tl.total)}s; the limit is ${maxSeconds}s`);
  const audio = join(work, 'narration.wav');
  joinWavs(
    spoken.map((s) => s.file),
    VIDEO_LIMITS.cueGapSeconds,
    audio,
  );

  // 3. scene pictures
  const jobs: SceneJob[] = await browserJobsFor(tl, orient, work, opts.images, opts.clips);
  log(`rendering ${jobs.length} scene pictures`);
  await renderPngs(jobs.map((j) => j.png));
  const thumbPath = join(out, 'thumb.png');
  if (!short) {
    await renderPngs([thumbnailJob(script, thumbPath)]);
    log('thumbnail written');
  }

  // 4. one video-only segment per scene
  const lens = streamDurations(tl);
  const segFiles: string[] = [];
  jobs.forEach((job, i) => {
    const seg = join(work, `seg-${String(i).padStart(3, '0')}.mp4`);
    const dur = lens[i] as number;
    const frames = Math.round(dur * fps);
    const enc = [
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '12',
      '-pix_fmt',
      'yuv420p',
      '-r',
      String(fps),
      '-frames:v',
      String(frames),
      seg,
    ];
    if (job.clip) {
      const b = clipBox(orient);
      const fit = fitClip(dur, job.clip.to - job.clip.from);
      runFfmpeg(
        [
          '-loop',
          '1',
          '-framerate',
          String(fps),
          '-i',
          job.png.out,
          '-ss',
          job.clip.from.toFixed(3),
          '-t',
          fit.take.toFixed(3),
          '-i',
          job.clip.file,
          '-filter_complex',
          `[1:v]setpts=(PTS-STARTPTS)/${fit.speed.toFixed(4)},fps=${fps},scale=${b.w}:${b.h}:force_original_aspect_ratio=decrease,pad=${b.w}:${b.h}:(ow-iw)/2:(oh-ih)/2:black,tpad=stop_mode=clone:stop_duration=${(fit.freeze + 2).toFixed(3)}[c];[0:v][c]overlay=${b.x}:${b.y}:shortest=0,format=yuv420p[v]`,
          '-map',
          '[v]',
          '-t',
          dur.toFixed(3),
          ...enc,
        ],
        { bin: ff },
      );
    } else {
      runFfmpeg(
        [
          '-i',
          job.png.out,
          '-vf',
          `scale=${width * 2}:${height * 2}:flags=lanczos,zoompan=z='1+0.05*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},format=yuv420p`,
          ...enc,
        ],
        { bin: ff },
      );
    }
    segFiles.push(seg);
  });
  log(`${segFiles.length} segments encoded`);

  // 5. captions
  const captionCues = tl.cues.map((c) => ({ start: c.start, end: c.end, text: c.text }));
  const vttFile = join(out, 'captions.vtt');
  const srtFile = join(out, 'captions.srt');
  writeFileSync(vttFile, vtt(captionCues));
  writeFileSync(srtFile, srt(captionCues));
  if (short)
    writeFileSync(
      join(work, 'burn.ass'),
      ass(
        captionCues.flatMap((c) => chunkCaption(c)),
        width,
        height,
      ),
    );

  // 6. cross fade, mix, encode
  const final = join(out, short ? 'short.mp4' : 'video.mp4');
  const offs = xfadeOffsets(tl);
  const parts: string[] = [];
  let last = '[0:v]';
  offs.forEach((o, i) => {
    const label = `[x${i}]`;
    parts.push(
      `${last}[${i + 1}:v]xfade=transition=fade:duration=${XFADE_SECONDS}:offset=${o.toFixed(3)}${label}`,
    );
    last = label;
  });
  parts.push(`${last}${short ? 'ass=burn.ass,' : ''}format=yuv420p[vout]`);
  const args = [
    ...segFiles.flatMap((f) => ['-i', f]),
    '-i',
    audio,
    '-filter_complex',
    parts.join(';'),
    '-map',
    '[vout]',
    '-map',
    `${segFiles.length}:a`,
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    'medium',
    '-crf',
    String(opts.crf ?? 20),
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    tl.total.toFixed(3),
    '-movflags',
    '+faststart',
    final,
  ];
  runFfmpeg(args, { bin: ff, cwd: work });
  const durationSeconds = probeDuration(final, ff);
  const bytes = statSync(final).size;
  log(`encoded ${final}: ${durationSeconds.toFixed(1)}s, ${(bytes / 1e6).toFixed(1)} MB`);

  // 7. description, script, log
  const descriptionText = buildDescription(script, tl.chapters, durationSeconds);
  const descFile = join(out, 'description.txt');
  writeFileSync(descFile, descriptionText);
  const scriptFile = join(out, 'script.json');
  writeFileSync(scriptFile, `${JSON.stringify(script, null, 2)}\n`);
  const logFile = join(out, 'render.log');
  const renderSeconds = (Date.now() - started) / 1000;
  log(`done in ${renderSeconds.toFixed(1)}s`);
  writeFileSync(logFile, `${lines.join('\n')}\n`);
  if (!opts.keepWork && !opts.workDir) rmSync(work, { recursive: true, force: true });
  return {
    artifacts: {
      video: final,
      captionsVtt: vttFile,
      captionsSrt: srtFile,
      thumb: short ? null : thumbPath,
      script: scriptFile,
      description: descFile,
      log: logFile,
    },
    descriptionText,
    durationSeconds,
    bytes,
    width,
    height,
    timeline: tl,
    voice,
    renderSeconds,
  };
}
