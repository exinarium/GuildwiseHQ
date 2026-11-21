import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReelsCheck } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  checkReelsFile,
  type DetectDeps,
  detectEncoder,
  EncoderSession,
  encodeArgs,
  type FfmpegRun,
  nvencReason,
  nvencTestEncodeArgs,
  nvencVideoArgs,
  REELS_LIMITS,
  segmentEncodeArgs,
} from '../src/index.ts';

const BIN = '/opt/ffmpeg-gpu/bin/ffmpeg';
const passed: ReelsCheck = {
  passed: true,
  checkedAt: new Date().toISOString(),
  failed: [],
  warnings: [],
  measured: {},
};

/** A fake ffmpeg: `-encoders` lists what `encoders` says; any other call is the test encode. */
function fake(o: { encoders?: string; encode?: FfmpegRun; reels?: ReelsCheck; exists?: boolean } = {}) {
  const calls: string[][] = [];
  const deps: DetectDeps = {
    env: { AOM_FFMPEG_GPU: BIN },
    exists: () => o.exists ?? true,
    run: async (_bin, args) => {
      calls.push(args);
      if (args.includes('-encoders'))
        return {
          ok: true,
          stdout: o.encoders ?? ' V....D h264_nvenc  NVIDIA NVENC H.264 encoder',
          stderr: '',
        };
      return o.encode ?? { ok: true, stdout: '', stderr: '' };
    },
    reelsCheck: async () => o.reels ?? passed,
  };
  return { deps, calls };
}

describe('detectEncoder', () => {
  it('picks nvenc when the GPU ffmpeg lists h264_nvenc and the test encode passes the Reels check', async () => {
    const f = fake();
    expect(await detectEncoder(f.deps)).toEqual({ encoder: 'nvenc', reason: null, bin: BIN });
    const test = f.calls[1] as string[];
    expect(test).toContain('testsrc2=size=1080x1920:rate=30:duration=3');
    // the exact final-encode NVENC arguments
    const nv = nvencVideoArgs({ crf: 20, fps: 30 });
    expect(test.join(' ')).toContain(nv.join(' '));
  });

  it('no h264_nvenc in the GPU ffmpeg gives cpu with the reason', async () => {
    const r = await detectEncoder(fake({ encoders: ' V..... libx264' }).deps);
    expect(r.encoder).toBe('cpu');
    expect(r.reason).toMatch(/no h264_nvenc encoder/);
  });

  it('a missing GPU ffmpeg gives cpu', async () => {
    const r = await detectEncoder(fake({ exists: false }).deps);
    expect(r).toMatchObject({ encoder: 'cpu', bin: null });
    expect(r.reason).toMatch(/no GPU ffmpeg at/);
  });

  it('a failed test encode gives cpu plus the reason from ffmpeg (missing libnvidia-encode names the host package)', async () => {
    const r = await detectEncoder(
      fake({
        encode: {
          ok: false,
          stdout: '',
          stderr:
            '[h264_nvenc @ 0x5] Cannot load libnvidia-encode.so.1\n[h264_nvenc @ 0x5] The minimum required Nvidia driver for nvenc is 570.0 or newer\nError while opening encoder',
        },
      }).deps,
    );
    expect(r.encoder).toBe('cpu');
    expect(r.reason).toMatch(/install libnvidia-encode-595 on the host/);
  });

  it('a test encode that fails the Reels check gives cpu', async () => {
    const r = await detectEncoder(
      fake({
        reels: {
          ...passed,
          passed: false,
          failed: [
            { rule: 'video_bitrate', message: 'video bitrate 30000 kb/s > 25000', measured: null, limit: '' },
          ],
        },
      }).deps,
    );
    expect(r.encoder).toBe('cpu');
    expect(r.reason).toMatch(/Reels check: video bitrate/);
  });

  it('AOM_VIDEO_GPU=off is cpu without running anything', async () => {
    const f = fake();
    const r = await detectEncoder({ ...f.deps, env: { AOM_VIDEO_GPU: 'off' } });
    expect(r).toEqual({ encoder: 'cpu', reason: 'AOM_VIDEO_GPU=off', bin: null });
    expect(f.calls).toEqual([]);
  });

  it('AOM_VIDEO_GPU=require throws instead of falling back, and passes when NVENC works', async () => {
    const f = fake({ encoders: 'libx264' });
    await expect(
      detectEncoder({ ...f.deps, env: { AOM_VIDEO_GPU: 'require', AOM_FFMPEG_GPU: BIN } }),
    ).rejects.toThrow(/AOM_VIDEO_GPU=require but NVENC is not usable/);
    const ok = fake();
    expect(
      (await detectEncoder({ ...ok.deps, env: { AOM_VIDEO_GPU: 'require', AOM_FFMPEG_GPU: BIN } })).encoder,
    ).toBe('nvenc');
  });
});

describe('nvencReason', () => {
  it.each([
    ['Cannot load libcuda.so.1', /no NVIDIA GPU is visible/],
    ['No capable devices found', /no NVIDIA GPU is visible/],
    [
      'Driver does not support the required nvenc API version. Required: 13.0 Found: 12.1',
      /driver is too old/,
    ],
    ['OpenEncodeSessionEx failed: out of memory (10)', /refused an encode session/],
    ['something else entirely\nlast line here', /NVENC failed: last line here/],
  ])('%s', (stderr, re) => {
    expect(nvencReason(stderr)).toMatch(re);
  });
});

describe('NVENC arguments', () => {
  const base = {
    segments: ['seg-000.mp4', 'seg-001.mp4'],
    audio: 'narration.wav',
    filter: '[0:v][1:v]xfade[x0];[x0]format=yuv420p[vout]',
    crf: 20,
    fps: 30,
    seconds: 10,
    out: 'video.mp4',
  };

  it('the final encode stays inside the Reels limits: capped bitrate, High profile, yuv420p, closed GOP; audio and mux unchanged', () => {
    const a = encodeArgs({ ...base, encoder: 'nvenc' });
    const at = (k: string) => a[a.indexOf(k) + 1];
    expect(at('-c:v')).toBe('h264_nvenc');
    expect(at('-cq')).toBe('21');
    expect(at('-preset')).toBe('p5');
    expect(at('-rc')).toBe('vbr');
    expect(Number.parseInt(at('-maxrate') as string, 10) * 1000).toBeLessThanOrEqual(
      REELS_LIMITS.maxVideoKbps,
    );
    expect(REELS_LIMITS.h264Profiles.map((p) => p.toLowerCase())).toContain(at('-profile:v'));
    expect(REELS_LIMITS.pixelFormats as readonly string[]).toContain(at('-pix_fmt'));
    expect(at('-g')).toBe('60');
    expect(at('-forced-idr')).toBe('1');
    expect(a).not.toContain('libx264');
    expect(a).not.toContain('-x264-params');
    // everything after the video codec arguments is the same as the CPU encode
    const cpu = encodeArgs(base);
    expect(a.slice(a.indexOf('-c:a'))).toEqual(cpu.slice(cpu.indexOf('-c:a')));
    expect(a.slice(0, a.indexOf('-c:v'))).toEqual(cpu.slice(0, cpu.indexOf('-c:v')));
  });

  it('the CPU arguments are unchanged when no encoder is given', () => {
    expect(encodeArgs(base)).toContain('libx264');
    expect(segmentEncodeArgs({ fps: 30, frames: 90, out: 's.mp4', threads: 4 })).toContain('libx264');
  });

  it('segments: h264_nvenc preset p4, constant quality 12, same frame count', () => {
    const s = segmentEncodeArgs({ fps: 30, frames: 90, out: 's.mp4', threads: 4, encoder: 'nvenc' });
    expect(s.slice(0, 7)).toEqual(['-an', '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '12']);
    expect(s.slice(-3)).toEqual(['-frames:v', '90', 's.mp4']);
  });
});

describe('runtime fallback', () => {
  const session = (failGpu: boolean) => {
    const runs: string[] = [];
    const reasons: string[] = [];
    const lines: string[] = [];
    const s = new EncoderSession({
      gpu: { bin: 'gpu-ffmpeg' },
      cpuBin: 'cpu-ffmpeg',
      log: (l) => lines.push(l),
      onGpuFailure: (r) => reasons.push(r),
      run: (args, { bin }) => {
        runs.push(`${bin}:${args[0]}`);
        if (bin === 'gpu-ffmpeg' && failGpu)
          throw new Error('ffmpeg failed: Cannot load libnvidia-encode.so.1');
      },
    });
    return { s, runs, reasons, lines };
  };

  it('an NVENC encode that fails is retried on the CPU; later encodes stay on the CPU; reported once', () => {
    const t = session(true);
    t.s.encode(['seg0-cpu'], ['seg0-gpu']);
    t.s.encode(['seg1-cpu'], ['seg1-gpu']);
    t.s.encode(['final-cpu'], ['final-gpu'], '/work');
    expect(t.runs).toEqual([
      'gpu-ffmpeg:seg0-gpu',
      'cpu-ffmpeg:seg0-cpu',
      'cpu-ffmpeg:seg1-cpu',
      'cpu-ffmpeg:final-cpu',
    ]);
    expect(t.reasons).toHaveLength(1);
    expect(t.reasons[0]).toMatch(/libnvidia-encode-595/);
    expect(t.lines.join('\n')).toMatch(/NVENC encode failed, retrying on the CPU/);
    expect(t.s.used).toBe('cpu_fallback');
  });

  it('NVENC that works stays on the GPU and reports nvenc; without a GPU it is cpu', () => {
    const t = session(false);
    t.s.encode(['a-cpu'], ['a-gpu']);
    t.s.encode(['b-cpu'], ['b-gpu']);
    expect(t.runs).toEqual(['gpu-ffmpeg:a-gpu', 'gpu-ffmpeg:b-gpu']);
    expect(t.s.used).toBe('nvenc');
    const runs: string[] = [];
    const cpu = new EncoderSession({
      gpu: null,
      cpuBin: 'cpu-ffmpeg',
      log: () => {},
      run: (a) => runs.push(a[0] as string),
    });
    cpu.encode(['x-cpu'], ['x-gpu']);
    expect(runs).toEqual(['x-cpu']);
    expect(cpu.used).toBe('cpu');
  });
});

/** The real GPU: only on the DevBox with AOM_TEST_GPU=1 and AOM_FFMPEG_GPU pointing at the NVENC ffmpeg. */
describe.runIf(process.env.AOM_TEST_GPU === '1')('real NVENC (AOM_TEST_GPU=1)', () => {
  it('detects nvenc on this machine and the test encode passes the Reels check', async () => {
    const r = await detectEncoder();
    expect(r).toMatchObject({ encoder: 'nvenc', reason: null });
    const dir = mkdtempSync(join(tmpdir(), 'nvenc-real-'));
    try {
      const { execFileSync } = await import('node:child_process');
      const out = join(dir, 't.mp4');
      execFileSync(r.bin as string, nvencTestEncodeArgs(out));
      const check = await checkReelsFile(out, { bin: r.bin as string });
      expect(check.failed).toEqual([]);
      expect(check.measured.videoCodec).toBe('h264');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
