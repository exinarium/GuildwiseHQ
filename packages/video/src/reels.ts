import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import type { ReelsCheck, ReelsRuleId } from '@aom/shared';
import { findFfmpeg, RENDER_ENCODERS } from './ffmpeg.ts';

/**
 * Instagram's Reels container rules (Meta's IG User Media reference, "Reels specifications", checked 2026-11-16).
 * This is the one place the values live: update them here when Meta changes them.
 *
 * Closed GOP is also required but cannot be read from `ffmpeg -i`, so it is not checked (libx264 writes closed GOPs by
 * default).
 */
export const REELS_LIMITS = {
  /** Major brands of an MP4/MOV container. */
  containers: ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'qt  ', 'M4V '],
  /** No edit lists (`edts/elst`). */
  editList: false,
  /** The moov atom comes before the media data. */
  faststart: true,
  videoCodecs: ['h264', 'hevc'],
  h264Profiles: ['Baseline', 'Constrained Baseline', 'Main', 'High'],
  pixelFormats: ['yuv420p', 'yuvj420p'],
  progressive: true,
  fps: { min: 23, max: 60 },
  maxWidth: 1920,
  aspect: { min: 0.01, max: 10 },
  recommendedAspect: 9 / 16,
  maxVideoKbps: 25_000,
  durationS: { min: 3, max: 900 },
  maxBytes: 300 * 1024 * 1024,
  audioCodecs: ['aac'],
  maxSampleRate: 48_000,
  channels: { min: 1, max: 2 },
} as const;
export type ReelsLimits = typeof REELS_LIMITS;

export interface Mp4Structure {
  /** The major brand of the `ftyp` box, or null when there is none. */
  brand: string | null;
  topLevel: string[];
  hasMoov: boolean;
  /** `moov` comes before the first `mdat` (or there is no `mdat`). */
  moovBeforeMdat: boolean;
  /** The handler type ('vide', 'soun', ...) of every track that has an edit list with entries. */
  editListTracks: string[];
}

const MAX_MOOV = 256 * 1024 * 1024;

async function readAt(fh: Awaited<ReturnType<typeof open>>, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

interface Box {
  type: string;
  start: number;
  headerSize: number;
  size: number;
}

/** Child boxes inside a buffer (the payload of a container box). */
function children(buf: Buffer, from = 0, to = buf.length): Array<Box & { payload: Buffer }> {
  const out: Array<Box & { payload: Buffer }> = [];
  let pos = from;
  while (pos + 8 <= to) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) break;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) size = to - pos;
    if (size < header || pos + size > to) break;
    out.push({ type, start: pos, headerSize: header, size, payload: buf.subarray(pos + header, pos + size) });
    pos += size;
  }
  return out;
}

/** The box tree facts of an MP4 (no binary: the top-level boxes are walked, only `moov` is read into memory). */
export async function mp4Structure(file: string): Promise<Mp4Structure> {
  const total = (await stat(file)).size;
  const fh = await open(file, 'r');
  const res: Mp4Structure = {
    brand: null,
    topLevel: [],
    hasMoov: false,
    moovBeforeMdat: true,
    editListTracks: [],
  };
  try {
    let pos = 0;
    let mdatSeen = false;
    while (pos + 8 <= total) {
      const head = await readAt(fh, pos, 16);
      if (head.length < 8) break;
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (size === 1) {
        if (head.length < 16) break;
        size = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (size === 0) size = total - pos;
      if (size < header || pos + size > total) {
        if (res.topLevel.length === 0) throw new Error('not an MP4 file');
        break;
      }
      if (res.topLevel.length === 0 && !/^[\x20-\x7e]{4}$/.test(type)) throw new Error('not an MP4 file');
      res.topLevel.push(type);
      if (type === 'ftyp') res.brand = (await readAt(fh, pos + header, 4)).toString('latin1');
      else if (type === 'mdat') mdatSeen = true;
      else if (type === 'moov') {
        res.hasMoov = true;
        if (mdatSeen) res.moovBeforeMdat = false;
        if (size - header <= MAX_MOOV) {
          const moov = await readAt(fh, pos + header, size - header);
          for (const trak of children(moov).filter((b) => b.type === 'trak')) {
            const parts = children(trak.payload);
            const elst = children(parts.find((b) => b.type === 'edts')?.payload ?? Buffer.alloc(0)).find(
              (b) => b.type === 'elst',
            );
            if (!elst || elst.payload.length < 8 || elst.payload.readUInt32BE(4) === 0) continue;
            const mdia = parts.find((b) => b.type === 'mdia');
            const hdlr = mdia && children(mdia.payload).find((b) => b.type === 'hdlr');
            res.editListTracks.push(
              hdlr && hdlr.payload.length >= 12 ? hdlr.payload.toString('latin1', 8, 12) : 'unknown',
            );
          }
        }
      }
      pos += size;
    }
  } finally {
    await fh.close();
  }
  return res;
}

export interface StreamInfo {
  durationS: number | null;
  /** The container's overall bitrate, kb/s. */
  bitrateKbps: number | null;
  video: {
    codec: string;
    profile: string | null;
    pixelFormat: string | null;
    /** null: ffmpeg did not say. */
    progressive: boolean | null;
    width: number;
    height: number;
    fps: number | null;
    kbps: number | null;
  } | null;
  audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
}

const INTERLACED = new Set(['tt', 'bb', 'tb', 'bt', 'top first', 'bottom first']);

/** The stream facts out of the text `ffmpeg -i` prints on stderr (there is no ffprobe in the static build). */
export function parseStreamInfo(stderr: string): StreamInfo {
  const info: StreamInfo = { durationS: null, bitrateKbps: null, video: null, audio: null };
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)(?:,[^\n]*?bitrate:\s*(\d+)\s*kb\/s)?/.exec(stderr);
  if (d) {
    info.durationS = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
    if (d[4]) info.bitrateKbps = Number(d[4]);
  }
  const lines = stderr.split('\n');
  const vline = lines.find((l) => /Stream #\S+.*?:\s*Video:/.test(l) && !/attached pic/.test(l));
  if (vline) {
    const body = vline.slice(vline.indexOf('Video:') + 6);
    const codec = /^\s*([\w-]+)(?:\s*\(([^)]*)\))?/.exec(body);
    const pix = /,\s*([a-z][a-z0-9]*)(?:\(([^)]*)\))?,\s*(\d{2,5})x(\d{2,5})/.exec(body);
    const fps = /([\d.]+)\s*fps/.exec(body);
    const kbps = /,\s*(\d+)\s*kb\/s/.exec(body);
    if (codec && pix) {
      const flags = (pix[2] ?? '').split(',').map((x) => x.trim());
      info.video = {
        codec: codec[1] as string,
        profile: codec[2] ?? null,
        pixelFormat: pix[1] as string,
        progressive: flags.includes('progressive') ? true : flags.some((f) => INTERLACED.has(f)) ? false : null,
        width: Number(pix[3]),
        height: Number(pix[4]),
        fps: fps ? Number(fps[1]) : null,
        kbps: kbps ? Number(kbps[1]) : null,
      };
    }
  }
  const aline = lines.find((l) => /Stream #\S+.*?:\s*Audio:/.test(l));
  if (aline) {
    const body = aline.slice(aline.indexOf('Audio:') + 6);
    const codec = /^\s*([\w-]+)/.exec(body);
    const hz = /(\d+)\s*Hz/.exec(body);
    const layout = /Hz,\s*([^,]+)/.exec(body)?.[1]?.trim() ?? '';
    const channels = /^mono/.test(layout)
      ? 1
      : /^stereo/.test(layout)
        ? 2
        : /^(\d+)\s*channels/.test(layout)
          ? Number(/^(\d+)/.exec(layout)?.[1])
          : /^(\d)\.(\d)/.test(layout)
            ? Number(/^(\d)\.(\d)/.exec(layout)?.[1]) + Number(/^(\d)\.(\d)/.exec(layout)?.[2])
            : null;
    if (codec) info.audio = { codec: codec[1] as string, sampleRate: hz ? Number(hz[1]) : null, channels };
  }
  return info;
}

export interface ReelsFacts {
  bytes: number;
  structure: Mp4Structure;
  stream: StreamInfo;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** The facts against the limits: every failed rule with the measured value. Pure. */
export function evaluateReels(facts: ReelsFacts, limits: ReelsLimits = REELS_LIMITS): ReelsCheck {
  const failed: ReelsCheck['failed'] = [];
  const warnings: string[] = [];
  const fail = (rule: ReelsRuleId, message: string, measured: string | null, limit: string) =>
    failed.push({ rule, message, measured, limit });
  const { structure: st, stream: s, bytes } = facts;
  const v = s.video;
  const a = s.audio;
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

  if (!st.brand || !limits.containers.some((c) => c === st.brand))
    fail('container', `container brand ${st.brand ?? 'missing'} is not MP4/MOV`, st.brand, limits.containers.join(', '));
  if (!limits.editList && st.editListTracks.length > 0)
    fail('edit_list', `edit list present (${st.editListTracks.join(', ')})`, st.editListTracks.join(', '), 'none');
  if (limits.faststart && (!st.hasMoov || !st.moovBeforeMdat))
    fail(
      'faststart',
      st.hasMoov ? 'moov not at start' : 'moov missing',
      st.hasMoov ? 'moov after mdat' : 'missing',
      'moov before mdat',
    );
  if (bytes > limits.maxBytes)
    fail('file_size', `file size ${mb(bytes)} > ${mb(limits.maxBytes)}`, mb(bytes), `${mb(limits.maxBytes)}`);
  if (s.durationS !== null) {
    const sec = `${s.durationS.toFixed(1)} s`;
    if (s.durationS < limits.durationS.min)
      fail('duration', `duration ${sec} < ${limits.durationS.min} s`, sec, `${limits.durationS.min}-${limits.durationS.max} s`);
    else if (s.durationS > limits.durationS.max)
      fail('duration', `duration ${sec} > ${limits.durationS.max} s`, sec, `${limits.durationS.min}-${limits.durationS.max} s`);
  }
  if (!v) {
    fail('readable', 'no video stream could be read', null, 'one video stream');
  } else {
    if (!(limits.videoCodecs as readonly string[]).includes(v.codec))
      fail('video_codec', `video codec ${v.codec} is not ${limits.videoCodecs.join('/')}`, v.codec, limits.videoCodecs.join(', '));
    if (v.codec === 'h264' && v.profile && !(limits.h264Profiles as readonly string[]).includes(v.profile))
      fail('video_profile', `H.264 profile ${v.profile} not allowed`, v.profile, limits.h264Profiles.join(', '));
    if (v.pixelFormat && !(limits.pixelFormats as readonly string[]).includes(v.pixelFormat))
      fail('pixel_format', `pixel format ${v.pixelFormat} is not 4:2:0`, v.pixelFormat, limits.pixelFormats.join(', '));
    if (limits.progressive && v.progressive === false)
      fail('scan', 'video is interlaced', 'interlaced', 'progressive');
    if (v.fps !== null) {
      if (v.fps > limits.fps.max + 0.01)
        fail('frame_rate', `frame rate ${v.fps} > ${limits.fps.max}`, String(v.fps), `${limits.fps.min}-${limits.fps.max}`);
      else if (v.fps < limits.fps.min - 0.01)
        fail('frame_rate', `frame rate ${v.fps} < ${limits.fps.min}`, String(v.fps), `${limits.fps.min}-${limits.fps.max}`);
    }
    if (v.width > limits.maxWidth)
      fail('width', `width ${v.width} > ${limits.maxWidth}`, String(v.width), `<= ${limits.maxWidth}`);
    const ratio = v.height > 0 ? v.width / v.height : 0;
    if (ratio < limits.aspect.min || ratio > limits.aspect.max)
      fail(
        'aspect_ratio',
        `aspect ratio ${v.width}:${v.height} outside ${limits.aspect.min}:1 to ${limits.aspect.max}:1`,
        `${v.width}:${v.height}`,
        `${limits.aspect.min}:1 to ${limits.aspect.max}:1`,
      );
    else if (Math.abs(ratio - limits.recommendedAspect) > 0.02) {
      const g = gcd(v.width, v.height) || 1;
      warnings.push(`aspect ratio ${v.width / g}:${v.height / g} (9:16 recommended)`);
    }
    if (v.kbps !== null && v.kbps > limits.maxVideoKbps)
      fail('video_bitrate', `video bitrate ${v.kbps} kb/s > ${limits.maxVideoKbps}`, `${v.kbps} kb/s`, `<= ${limits.maxVideoKbps} kb/s`);
  }
  if (a) {
    if (!(limits.audioCodecs as readonly string[]).includes(a.codec))
      fail('audio_codec', `audio codec ${a.codec} is not ${limits.audioCodecs.join('/')}`, a.codec, limits.audioCodecs.join(', '));
    if (a.sampleRate !== null && a.sampleRate > limits.maxSampleRate)
      fail('audio_sample_rate', `audio sample rate ${a.sampleRate} > ${limits.maxSampleRate}`, String(a.sampleRate), `<= ${limits.maxSampleRate}`);
    if (a.channels !== null && (a.channels < limits.channels.min || a.channels > limits.channels.max))
      fail('audio_channels', `audio channels ${a.channels} not ${limits.channels.min}-${limits.channels.max}`, String(a.channels), `${limits.channels.min}-${limits.channels.max}`);
  }
  return {
    passed: failed.length === 0,
    checkedAt: new Date().toISOString(),
    failed,
    warnings,
    measured: {
      bytes,
      brand: st.brand,
      moovBeforeMdat: st.moovBeforeMdat,
      editListTracks: st.editListTracks.join(',') || null,
      durationS: s.durationS,
      videoCodec: v?.codec ?? null,
      videoProfile: v?.profile ?? null,
      pixelFormat: v?.pixelFormat ?? null,
      width: v?.width ?? null,
      height: v?.height ?? null,
      fps: v?.fps ?? null,
      audioCodec: a?.codec ?? null,
      audioSampleRate: a?.sampleRate ?? null,
      audioChannels: a?.channels ?? null,
    },
  };
}

const CHECK_TIMEOUT_MS = 60_000;

function ffmpegInfo(bin: string, file: string): Promise<string> {
  return new Promise((resolve) => {
    // `ffmpeg -i` with no output exits with an error and prints the stream facts on stderr
    execFile(
      bin,
      ['-hide_banner', '-i', file],
      { timeout: CHECK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (_e, _out, err) => resolve(String(err ?? '')),
    );
  });
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * The whole check on a file. A file that cannot be read is a failed `readable` rule; it throws only when no ffmpeg is found.
 */
export async function checkReelsFile(file: string, opts: { bin?: string } = {}): Promise<ReelsCheck> {
  const bin = opts.bin ?? findFfmpeg(RENDER_ENCODERS);
  let bytes: number;
  let structure: Mp4Structure;
  try {
    bytes = (await stat(file)).size;
    structure = await mp4Structure(file);
  } catch (e) {
    return {
      passed: false,
      checkedAt: new Date().toISOString(),
      failed: [
        {
          rule: 'readable',
          message: `the file cannot be read as an MP4: ${(e as Error).message}`,
          measured: null,
          limit: 'a readable MP4',
        },
      ],
      warnings: [],
      measured: {},
    };
  }
  const stream = parseStreamInfo(await ffmpegInfo(bin, file));
  const result = evaluateReels({ bytes, structure, stream });
  return { ...result, sha256: await sha256(file).catch(() => undefined) };
}
