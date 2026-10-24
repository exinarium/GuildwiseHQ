import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Cue } from './narration/types.ts';

/**
 * Offline text to speech for the help videos: Kokoro-82M (kokoro-onnx, CPU) with the `af_heart` voice, no account and
 * no network after setup. `e2e/video/setup-voice.sh` installs it and a static ffmpeg into `AOM_VIDEO_HOME` (default
 * ~/.cache/aom-video). `AOM_VIDEO_TTS=piper` selects the old Piper engine. Audio is cached by engine, voice, speed
 * and text, so unchanged cues are not spoken again.
 */
export const VIDEO_HOME = process.env.AOM_VIDEO_HOME ?? join(homedir(), '.cache/aom-video');
export const ENGINE: 'kokoro' | 'piper' = process.env.AOM_VIDEO_TTS === 'piper' ? 'piper' : 'kokoro';
export const VOICE = process.env.AOM_VIDEO_VOICE ?? (ENGINE === 'piper' ? 'en_GB-cori-high' : 'af_heart');
/** Kokoro: speaking speed (1 is normal). Piper: the length scale (above 1 is slower), kept for the old engine. */
export const SPEED =
  (ENGINE === 'piper' ? process.env.AOM_VIDEO_LENGTH_SCALE : process.env.AOM_VIDEO_SPEED) ??
  (ENGINE === 'piper' ? '1.08' : '1');
/** For the sidecar JSON: which voice spoke. */
export const VOICE_LABEL = `${ENGINE === 'piper' ? 'Piper' : 'Kokoro'} ${VOICE}`;
const PIPER = process.env.AOM_PIPER ?? join(VIDEO_HOME, 'venv/bin/piper');
const PIPER_MODEL = join(VIDEO_HOME, 'voices', `${VOICE}.onnx`);
const KOKORO_PYTHON = process.env.AOM_KOKORO_PYTHON ?? join(VIDEO_HOME, 'kokoro-venv/bin/python');
const KOKORO_MODEL = join(VIDEO_HOME, 'kokoro/kokoro-v1.0.onnx');
const KOKORO_VOICES = join(VIDEO_HOME, 'kokoro/voices-v1.0.bin');
const KOKORO_SAY = join(import.meta.dirname, 'kokoro-say.py');

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
  return ENGINE === 'piper'
    ? existsSync(PIPER) && existsSync(PIPER_MODEL)
    : existsSync(KOKORO_PYTHON) && existsSync(KOKORO_MODEL) && existsSync(KOKORO_VOICES);
}

/** The cache file name for a passage: engine, voice, speed and text decide it. */
export function cacheKey(speech: string): string {
  return createHash('sha1').update(`${ENGINE}|${VOICE}|${SPEED}|${speech}`).digest('hex').slice(0, 16);
}

export function speak(cues: Cue[]): Spoken[] {
  if (!voiceAvailable())
    throw new Error(
      ENGINE === 'piper'
        ? `Piper or the voice is missing (${PIPER}, ${PIPER_MODEL}). Run e2e/video/setup-voice.sh first.`
        : `Kokoro or the voice is missing (${KOKORO_PYTHON}, ${KOKORO_MODEL}, ${KOKORO_VOICES}). Run e2e/video/setup-voice.sh first.`,
    );
  const dir = join(VIDEO_HOME, 'audio');
  mkdirSync(dir, { recursive: true });
  return cues.map((c) => {
    const speech = c.speech ?? c.text;
    const key = cacheKey(speech);
    const file = join(dir, `${key}.wav`);
    if (!existsSync(file)) {
      // written under a private name, then renamed: recordings running at once share this cache
      const part = join(dir, `${key}.${process.pid}.part.wav`);
      if (ENGINE === 'piper') {
        const txt = join(dir, `${key}.${process.pid}.txt`);
        writeFileSync(txt, speech);
        execFileSync(
          PIPER,
          ['-m', PIPER_MODEL, '-i', txt, '-f', part, '--length-scale', SPEED, '--sentence-silence', '0.3'],
          { stdio: 'ignore' },
        );
      } else {
        execFileSync(
          KOKORO_PYTHON,
          [
            KOKORO_SAY,
            '--out',
            part,
            '--voice',
            VOICE,
            '--speed',
            SPEED,
            '--model',
            KOKORO_MODEL,
            '--voices',
            KOKORO_VOICES,
          ],
          { input: speech, stdio: ['pipe', 'ignore', 'inherit'] },
        );
      }
      renameSync(part, file);
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
      if (enc.includes('libopus') && enc.includes('libvpx-vp9') && enc.includes('libx264')) return bin;
    } catch {
      /* next */
    }
  }
  throw new Error(
    'no ffmpeg with libopus, libvpx-vp9 and libx264 found (run e2e/video/setup-voice.sh, or set AOM_FFMPEG)',
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

/** An MP4 copy (H.264 + AAC, fast start) of the finished WebM: plays on iPhone, Android and in-app browsers. */
export function toMp4(src: string, dest: string): void {
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
      '23',
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
