import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReelsCheck } from '@aom/shared';
import { MP4_MUX_ARGS, runFfmpeg } from './ffmpeg.ts';
import { checkReelsFile } from './reels.ts';

/**
 * GPU encoding (core DESIGN R19, R23): NVENC through a second, GPU-capable ffmpeg (`AOM_FFMPEG_GPU`, in the worker image
 * `/opt/ffmpeg-gpu/bin/ffmpeg`, a pinned static BtbN build). The CPU ffmpeg and its arguments are untouched: this file
 * only adds the NVENC arguments and the start-up detection. NVENC loads `libnvidia-encode.so.1` from the host at run
 * time, so the image carries no driver.
 */

/** `AOM_VIDEO_GPU`: `off` = always the CPU; `require` = exit instead of falling back (testing); anything else = auto. */
export type GpuMode = 'auto' | 'off' | 'require';
export const gpuMode = (v: string | undefined): GpuMode => (v === 'off' || v === 'require' ? v : 'auto');

/** Where the worker image puts the GPU ffmpeg (Dockerfile stage `ffmpeg-gpu`). */
export const DEFAULT_FFMPEG_GPU = '/opt/ffmpeg-gpu/bin/ffmpeg';

/** The encoder the worker picked at start: `nvenc` with the GPU ffmpeg, or `cpu` with the reason. */
export interface EncoderChoice {
  encoder: 'nvenc' | 'cpu';
  /** Why the worker is on the CPU (null on nvenc). */
  reason: string | null;
  /** The GPU ffmpeg (null on cpu). */
  bin: string | null;
}

export interface FfmpegRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface DetectDeps {
  env?: Readonly<Record<string, string | undefined>>;
  /** Runs a binary; tests fake it. */
  run?: (bin: string, args: string[]) => Promise<FfmpegRun>;
  exists?: (path: string) => boolean;
  /** The Reels check of the test encode (default `checkReelsFile` with the GPU ffmpeg reading the file). */
  reelsCheck?: (file: string, bin: string) => Promise<ReelsCheck>;
  /** Scratch directory for the test encode (default a fresh temp directory, removed afterwards). */
  workDir?: string;
}

const TEST_TIMEOUT_MS = 120_000;

const defaultRun = (bin: string, args: string[]): Promise<FfmpegRun> =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: TEST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }),
    );
  });

/**
 * The NVENC video arguments of the final encode: VBR with constant quality `crf + 1`, capped at 20 Mbit/s (inside the
 * Reels 25 Mbit/s), High profile, yuv420p, a keyframe every two seconds with IDR frames (closed GOP).
 */
export function nvencVideoArgs(o: { crf: number; fps: number }): string[] {
  return [
    '-c:v',
    'h264_nvenc',
    '-preset',
    'p5',
    '-tune',
    'hq',
    '-rc',
    'vbr',
    '-cq',
    String(o.crf + 1),
    '-b:v',
    '0',
    '-maxrate',
    '20M',
    '-bufsize',
    '40M',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-g',
    String(2 * o.fps),
    '-forced-idr',
    '1',
  ];
}

/** The NVENC video arguments of one scene segment (near-lossless intermediate, like the CPU's CRF 12). */
export const nvencSegmentVideoArgs = (): string[] => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '12'];

/** The detection's test encode: `seconds` of `testsrc2` at 1080x1920 through the exact final-encode NVENC arguments. */
export function nvencTestEncodeArgs(
  out: string,
  o: { fps?: number; seconds?: number; crf?: number } = {},
): string[] {
  const fps = o.fps ?? 30;
  const seconds = o.seconds ?? TEST_SECONDS;
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1080x1920:rate=${fps}:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    ...nvencVideoArgs({ crf: o.crf ?? 20, fps }),
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
    String(seconds),
    ...MP4_MUX_ARGS,
    out,
  ];
}

/**
 * The test encode's length. The design says 2 s, but the Reels check it must pass refuses anything under 3 s
 * (`REELS_LIMITS.durationS.min`), so it is 3 s.
 */
export const TEST_SECONDS = 3;

/** The host package NVENC needs on the DevBox (driver 595). */
export const NVENC_HOST_PACKAGE = 'libnvidia-encode-595';

/** A short, actionable reason from ffmpeg's stderr of a failed NVENC encode. */
export function nvencReason(stderr: string): string {
  const s = stderr || '';
  if (/libnvidia-encode\.so/i.test(s))
    return `libnvidia-encode.so.1 is missing: install ${NVENC_HOST_PACKAGE} on the host (ldconfig -p | grep libnvidia-encode)`;
  if (/libcuda\.so|cuInit|CUDA_ERROR_NO_DEVICE|no capable devices|No NVENC capable devices/i.test(s))
    return 'no NVIDIA GPU is visible to the worker (start the container with --gpus all and NVIDIA_DRIVER_CAPABILITIES including video)';
  if (/required nvenc API version|driver does not support|minimum required Nvidia driver/i.test(s))
    return 'the host NVIDIA driver is too old for the NVENC API of the GPU ffmpeg';
  if (/OpenEncodeSessionEx failed|out of memory|incompatible client key/i.test(s))
    return `the GPU refused an encode session: ${lastLine(s)}`;
  const line = lastLine(s);
  return line ? `NVENC failed: ${line}` : 'NVENC failed (no output from ffmpeg)';
}

function lastLine(s: string): string {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines[lines.length - 1] ?? '').slice(0, 300);
}

/**
 * Picks the encoder once at worker start:
 *   1. `AOM_VIDEO_GPU=off` means CPU;
 *   2. the GPU ffmpeg must exist and list `h264_nvenc`;
 *   3. a test encode (3 s of testsrc2 at 1080x1920, 30 fps, through the exact NVENC arguments) must pass the Reels check;
 *   4. then `nvenc`; otherwise `cpu` with the reason from ffmpeg's stderr.
 * `AOM_VIDEO_GPU=require` throws instead of answering `cpu`.
 */
export async function detectEncoder(deps: DetectDeps = {}): Promise<EncoderChoice> {
  const env = deps.env ?? process.env;
  const mode = gpuMode(env.AOM_VIDEO_GPU);
  const choice = await detect(env, mode, deps);
  if (mode === 'require' && choice.encoder !== 'nvenc')
    throw new Error(`AOM_VIDEO_GPU=require but NVENC is not usable: ${choice.reason}`);
  return choice;
}

async function detect(
  env: Readonly<Record<string, string | undefined>>,
  mode: GpuMode,
  deps: DetectDeps,
): Promise<EncoderChoice> {
  const cpu = (reason: string): EncoderChoice => ({ encoder: 'cpu', reason, bin: null });
  if (mode === 'off') return cpu('AOM_VIDEO_GPU=off');
  const bin = env.AOM_FFMPEG_GPU || DEFAULT_FFMPEG_GPU;
  const exists = deps.exists ?? existsSync;
  if (!exists(bin)) return cpu(`no GPU ffmpeg at ${bin} (AOM_FFMPEG_GPU)`);
  const run = deps.run ?? defaultRun;
  const enc = await run(bin, ['-hide_banner', '-encoders']);
  if (!enc.ok || !/\bh264_nvenc\b/.test(enc.stdout))
    return cpu(`the GPU ffmpeg at ${bin} has no h264_nvenc encoder`);
  const work = deps.workDir ?? mkdtempSync(join(tmpdir(), 'nvenc-test-'));
  const out = join(work, 'nvenc-test.mp4');
  try {
    const test = await run(bin, nvencTestEncodeArgs(out));
    if (!test.ok) return cpu(nvencReason(test.stderr));
    const check = await (deps.reelsCheck ?? ((f, b) => checkReelsFile(f, { bin: b })))(out, bin);
    if (!check.passed)
      return cpu(
        `the NVENC test encode fails the Reels check: ${check.failed.map((f) => f.message).join('; ')}`,
      );
    return { encoder: 'nvenc', reason: null, bin };
  } finally {
    if (!deps.workDir) rmSync(work, { recursive: true, force: true });
  }
}

/** What a render encoded with: `cpu_fallback` = NVENC failed during it and it finished on the CPU. */
export type RenderEncoderUsed = 'nvenc' | 'cpu' | 'cpu_fallback';

/**
 * The encodes of one render (R19 runtime fallback): each encode runs on NVENC while it works; the first NVENC failure is
 * logged, reported once through `onGpuFailure`, retried on the CPU, and every later encode of the render stays on the
 * CPU. A GPU problem never fails a render.
 */
export class EncoderSession {
  private gpu: { bin: string } | null;
  private fellBack = false;
  constructor(
    private readonly o: {
      gpu: { bin: string } | null | undefined;
      cpuBin: string;
      log: (line: string) => void;
      onGpuFailure?: ((reason: string) => void) | undefined;
      run?: (args: string[], opts: { bin: string; cwd?: string }) => void;
    },
  ) {
    this.gpu = o.gpu ?? null;
  }

  encode(cpuArgs: string[], gpuArgs: string[], cwd?: string): void {
    const run = this.o.run ?? runFfmpeg;
    if (this.gpu) {
      try {
        run(gpuArgs, { bin: this.gpu.bin, ...(cwd ? { cwd } : {}) });
        return;
      } catch (e) {
        const reason = nvencReason((e as Error).message);
        this.o.log(`NVENC encode failed, retrying on the CPU (libx264): ${reason}`);
        this.gpu = null;
        this.fellBack = true;
        this.o.onGpuFailure?.(reason);
      }
    }
    run(cpuArgs, { bin: this.o.cpuBin, ...(cwd ? { cwd } : {}) });
  }

  get used(): RenderEncoderUsed {
    return this.o.gpu ? (this.fellBack ? 'cpu_fallback' : 'nvenc') : 'cpu';
  }
}
