import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { VIDEO_HOME } from './voice.ts';

function venvFfmpeg(): string[] {
  try {
    const out = execFileSync(
      join(VIDEO_HOME, 'venv/bin/python'),
      ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
      { encoding: 'utf8' },
    );
    return [out.trim()];
  } catch {
    return [];
  }
}

/** The encoders the help-video recorder needs (WebM then MP4). */
export const RECORDER_ENCODERS = ['libopus', 'libvpx-vp9', 'libx264'];
/** The encoders and filters the renderer needs. */
export const RENDER_ENCODERS = ['libx264', 'aac'];

/** An ffmpeg with the given encoders: AOM_FFMPEG, the machine's, or the static build of imageio-ffmpeg in the venv. */
export function findFfmpeg(encoders: string[] = RECORDER_ENCODERS): string {
  const found = [process.env.AOM_FFMPEG, 'ffmpeg', ...venvFfmpeg()].filter((x): x is string => !!x);
  for (const bin of found) {
    try {
      const enc = execFileSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
      if (encoders.every((e) => enc.includes(e))) return bin;
    } catch {
      /* next */
    }
  }
  throw new Error(
    `no ffmpeg with ${encoders.join(', ')} found (run e2e/video/setup-voice.sh, or set AOM_FFMPEG)`,
  );
}

export const stamp = (s: number): string => {
  const ms = Math.round(s * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
};

/** WebVTT captions: one cue per narrated passage. */
export function vtt(cues: Array<{ start: number; end: number; text: string }>): string {
  return `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n')}`;
}

/** Video + narration (each clip delayed to its start) to WebM, VP9 + Opus. */
export function mux(
  videoIn: string,
  clips: Array<{ file: string; start: number }>,
  dest: string,
  crf = '36',
): void {
  const ff = findFfmpeg();
  const args = ['-y', '-i', videoIn];
  for (const c of clips) args.push('-i', c.file);
  const delays = clips
    .map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.start * 1000)}:all=1[a${i}]`)
    .join(';');
  const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,aresample=48000[aout]`;
  args.push(
    '-filter_complex',
    `${delays};${mix}`,
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    crf,
    '-row-mt',
    '1',
    '-cpu-used',
    '3',
    '-r',
    '25',
    '-c:a',
    'libopus',
    '-b:a',
    '56k',
    '-shortest',
    dest,
  );
  execFileSync(ff, args, { stdio: 'ignore' });
}

/** An MP4 copy (H.264 + AAC, fast start) of the finished WebM: plays on iPhone, Android and in-app browsers. */
export function toMp4(src: string, dest: string, crf = '23'): void {
  execFileSync(
    findFfmpeg(),
    [
      '-loglevel',
      'error',
      '-y',
      '-i',
      src,
      '-c:v',
      'libx264',
      '-profile:v',
      'high',
      '-level',
      '4.0',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'slow',
      '-crf',
      crf,
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      dest,
    ],
    { stdio: 'inherit' },
  );
}

/** Runs ffmpeg (quiet); a failure carries the tail of its output. */
export function runFfmpeg(args: string[], opts: { cwd?: string; bin?: string } = {}): void {
  const bin = opts.bin ?? findFfmpeg(RENDER_ENCODERS);
  try {
    execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      cwd: opts.cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const err = (e as { stderr?: Buffer }).stderr?.toString().slice(-2000) ?? String(e);
    throw new Error(`ffmpeg failed: ${err}`);
  }
}

/** The length of a media file in seconds (read from `ffmpeg -i`, there is no ffprobe in the static build). */
export function probeDuration(file: string, bin = findFfmpeg(RENDER_ENCODERS)): number {
  const out = (() => {
    try {
      execFileSync(bin, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
      return '';
    } catch (e) {
      return (e as { stderr?: Buffer }).stderr?.toString() ?? '';
    }
  })();
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
  if (!m) throw new Error(`cannot read the length of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
