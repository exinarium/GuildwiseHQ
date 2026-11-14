import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENCODE_THREADS,
  encodeArgs,
  MP4_MUX_ARGS,
  resolveEncodeThreads,
  segmentEncodeArgs,
  toMp4Args,
  x264ThreadArgs,
} from '../src/index.ts';

const base = {
  segments: ['seg-000.mp4', 'seg-001.mp4', 'seg-002.mp4'],
  audio: 'narration.wav',
  filter: '[0:v][1:v]xfade[x0];[x0][2:v]xfade[x1];[x1]format=yuv420p[vout]',
  crf: 20,
  fps: 30,
  seconds: 12.3456,
  out: 'short.mp4',
};

/** The final encode's arguments before thread caps existed, written out literally. */
const TODAY = [
  '-i',
  'seg-000.mp4',
  '-i',
  'seg-001.mp4',
  '-i',
  'seg-002.mp4',
  '-i',
  'narration.wav',
  '-filter_complex',
  base.filter,
  '-map',
  '[vout]',
  '-map',
  '3:a',
  '-c:v',
  'libx264',
  '-profile:v',
  'high',
  '-preset',
  'medium',
  '-crf',
  '20',
  '-pix_fmt',
  'yuv420p',
  '-r',
  '30',
  '-c:a',
  'aac',
  '-b:a',
  '160k',
  '-ar',
  '48000',
  '-ac',
  '2',
  '-t',
  '12.346',
  ...MP4_MUX_ARGS,
  'short.mp4',
];

/** The arguments with every `-threads x` and `-x264-params x` pair taken out. */
function withoutThreads(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-threads' || args[i] === '-x264-params') i++;
    else out.push(args[i] as string);
  }
  return out;
}

/** The output options: everything after the last input. */
const outputOptions = (args: string[]) => args.slice(args.lastIndexOf('-i') + 2);

describe('final encode threads (encodeArgs)', () => {
  it('caps the encoder with -threads n and -x264-params threads=n', () => {
    const out = outputOptions(encodeArgs({ ...base, threads: 4 }));
    expect(out.slice(out.indexOf('-threads'), out.indexOf('-threads') + 2)).toEqual(['-threads', '4']);
    expect(out[out.indexOf('-x264-params') + 1]).toBe('threads=4');
    // output options, after the codec settings
    expect(out.indexOf('-threads')).toBeGreaterThan(out.indexOf('-c:v'));
  });

  it('gives every segment decoder one thread, and not the narration input', () => {
    const args = encodeArgs({ ...base, threads: 6 });
    for (const seg of base.segments) {
      const i = args.indexOf(seg);
      expect(args.slice(i - 3, i)).toEqual(['-threads', '1', '-i']);
    }
    const a = args.indexOf('narration.wav');
    expect(args[a - 2]).not.toBe('1');
    expect(args.filter((x) => x === '-threads')).toHaveLength(base.segments.length + 1);
  });

  it('keeps every other argument as it was (codec, preset, CRF, pixel format, frame rate, audio)', () => {
    expect(withoutThreads(encodeArgs({ ...base, threads: 4 }))).toEqual(TODAY);
    expect(withoutThreads(encodeArgs(base))).toEqual(TODAY);
  });

  it('uses the default when no thread count is given', () => {
    expect(DEFAULT_ENCODE_THREADS).toBe(4);
    const out = outputOptions(encodeArgs(base));
    expect(out[out.indexOf('-threads') + 1]).toBe('4');
    expect(out[out.indexOf('-x264-params') + 1]).toBe('threads=4');
  });
});

describe('resolveEncodeThreads', () => {
  it('uses the default when nothing is asked for, whatever the cores', () => {
    expect(resolveEncodeThreads(undefined, 16)).toBe(4);
    expect(resolveEncodeThreads(undefined, 64)).toBe(4);
  });

  it('uses a valid whole number as asked', () => {
    expect(resolveEncodeThreads(3, 16)).toBe(3);
    expect(resolveEncodeThreads(1, 16)).toBe(1);
  });

  it('lowers a value above the cores to the cores, the default too', () => {
    expect(resolveEncodeThreads(32, 16)).toBe(16);
    expect(resolveEncodeThreads(4, 2)).toBe(2);
    expect(resolveEncodeThreads(undefined, 1)).toBe(1);
  });

  it('falls back to the default for 0, negative, fractional and non-numbers', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(resolveEncodeThreads(bad, 16)).toBe(4);
    expect(resolveEncodeThreads('abc' as unknown as number, 16)).toBe(4);
  });

  it('never returns less than 1 for odd core counts', () => {
    expect(resolveEncodeThreads(4, 0)).toBe(1);
    expect(resolveEncodeThreads(4, Number.NaN)).toBe(1);
  });

  it('defaults to the machine cores for the clamp', () => {
    const n = resolveEncodeThreads(10_000);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThan(10_000);
  });
});

describe('segment encode threads (segmentEncodeArgs)', () => {
  it('is the old segment encode plus the thread caps before -frames:v', () => {
    expect(segmentEncodeArgs({ fps: 30, frames: 90, out: 'seg.mp4', threads: 4 })).toEqual([
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
      '30',
      '-threads',
      '4',
      '-x264-params',
      'threads=4',
      '-frames:v',
      '90',
      'seg.mp4',
    ]);
  });
});

describe('toMp4 threads (toMp4Args)', () => {
  it('caps the encoder and keeps the quality settings', () => {
    const args = toMp4Args('a.webm', 'a.mp4', '23', 4);
    expect(args[args.indexOf('-threads') + 1]).toBe('4');
    expect(args[args.indexOf('-x264-params') + 1]).toBe('threads=4');
    expect(withoutThreads(args)).toEqual([
      '-loglevel',
      'error',
      '-y',
      '-i',
      'a.webm',
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
      ...MP4_MUX_ARGS,
      'a.mp4',
    ]);
  });

  it('uses the default (clamped to the cores) without a thread count', () => {
    const args = toMp4Args('a.webm', 'a.mp4');
    expect(args[args.indexOf('-threads') + 1]).toBe(String(resolveEncodeThreads(undefined)));
  });
});

describe('x264ThreadArgs', () => {
  it('sets ffmpeg and libx264 threads to the same number', () => {
    expect(x264ThreadArgs(2)).toEqual(['-threads', '2', '-x264-params', 'threads=2']);
  });
});
