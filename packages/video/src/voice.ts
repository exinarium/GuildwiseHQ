import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assetPath } from './assets.ts';

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
const KOKORO_SAY = assetPath('kokoro-say.py');

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

/** A passage to speak: `speech` (when given) is read instead of `text`. */
export interface SpeakCue {
  id: string;
  text: string;
  speech?: string;
}

export function speak(cues: SpeakCue[]): Spoken[] {
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
