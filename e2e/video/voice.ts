import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Cue } from './narration.ts';

/**
 * Offline text to speech for the getting-started video: Piper (https://github.com/rhasspy/piper) with a female
 * English voice, no account and no network after setup. `e2e/video/setup-voice.sh` installs Piper and the voice into
 * `AOM_VIDEO_HOME` (default ~/.cache/aom-video). Audio is cached by text, so unchanged cues are not spoken again.
 */
export const VIDEO_HOME = process.env.AOM_VIDEO_HOME ?? join(homedir(), '.cache/aom-video');
export const VOICE = process.env.AOM_VIDEO_VOICE ?? 'en_GB-jenny_dioco-medium';
const PIPER = process.env.AOM_PIPER ?? join(VIDEO_HOME, 'venv/bin/piper');
const MODEL = join(VIDEO_HOME, 'voices', `${VOICE}.onnx`);
const LENGTH_SCALE = process.env.AOM_VIDEO_LENGTH_SCALE ?? '1.08'; // a touch slower than default: easier to follow

export interface Spoken {
  id: string;
  file: string;
  /** Seconds. */
  duration: number;
}

/** The length of a PCM WAV file in seconds. */
export function wavSeconds(file: string): number {
  const b = readFileSync(file);
  let p = 12;
  let rate = 22050;
  let bytesPerSecond = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      rate = b.readUInt32LE(p + 12);
      bytesPerSecond = b.readUInt32LE(p + 16);
    }
    if (id === 'data') return Math.min(size, b.length - p - 8) / (bytesPerSecond || rate * 2);
    p += 8 + size + (size % 2);
  }
  throw new Error(`no audio data in ${file}`);
}

export function voiceAvailable(): boolean {
  return existsSync(PIPER) && existsSync(MODEL);
}

export function speak(cues: Cue[]): Spoken[] {
  if (!voiceAvailable())
    throw new Error(
      `Piper or the voice is missing (${PIPER}, ${MODEL}). Run e2e/video/setup-voice.sh first.`,
    );
  const dir = join(VIDEO_HOME, 'audio');
  mkdirSync(dir, { recursive: true });
  return cues.map((c) => {
    const speech = c.speech ?? c.text;
    const key = createHash('sha1').update(`${VOICE}|${LENGTH_SCALE}|${speech}`).digest('hex').slice(0, 16);
    const file = join(dir, `${key}.wav`);
    if (!existsSync(file)) {
      const txt = join(dir, `${key}.txt`);
      writeFileSync(txt, speech);
      execFileSync(
        PIPER,
        ['-m', MODEL, '-i', txt, '-f', file, '--length-scale', LENGTH_SCALE, '--sentence-silence', '0.3'],
        { stdio: 'ignore' },
      );
    }
    return { id: c.id, file, duration: wavSeconds(file) };
  });
}

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

/** An ffmpeg that can write VP9 and Opus: AOM_FFMPEG, the machine's, or the static build of imageio-ffmpeg in the venv. */
export function findFfmpeg(): string {
  const found = [process.env.AOM_FFMPEG, 'ffmpeg', ...venvFfmpeg()].filter((x): x is string => !!x);
  for (const bin of found) {
    try {
      const enc = execFileSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
      if (enc.includes('libopus') && enc.includes('libvpx-vp9')) return bin;
    } catch {
      /* next */
    }
  }
  throw new Error(
    'no ffmpeg with libopus and libvpx-vp9 found (run e2e/video/setup-voice.sh, or set AOM_FFMPEG)',
  );
}

const stamp = (s: number): string => {
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
