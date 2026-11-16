import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkReelsFile,
  encodeArgs,
  evaluateReels,
  findFfmpeg,
  mp4Structure,
  parseStreamInfo,
  REELS_LIMITS,
  RENDER_ENCODERS,
  type ReelsFacts,
  runFfmpeg,
  toMp4Args,
  writeSilentWav,
} from '../src/index.ts';

const fx = (n: string) => join(dirname(fileURLToPath(import.meta.url)), 'fixtures/reels', n);

function ffmpegAvailable(): boolean {
  try {
    findFfmpeg(RENDER_ENCODERS);
    return true;
  } catch {
    return false;
  }
}

describe('mp4Structure on committed fixtures', () => {
  it('flags the edit list (edts/elst) and the moov at the end', async () => {
    const s = await mp4Structure(fx('editlist.mp4'));
    expect(s.editListTracks.length).toBeGreaterThan(0);
    expect(s.editListTracks).toContain('vide');
    expect(s.moovBeforeMdat).toBe(false);
    expect(s.brand).toBe('isom');
  });
  it('flags a moov that comes after the media data, without an edit list', async () => {
    const s = await mp4Structure(fx('moov-at-end.mp4'));
    expect(s.editListTracks).toEqual([]);
    expect(s.topLevel.indexOf('moov')).toBeGreaterThan(s.topLevel.indexOf('mdat'));
    expect(s.moovBeforeMdat).toBe(false);
  });
  it('passes the same video with fast start and no edit list', async () => {
    const s = await mp4Structure(fx('compliant.mp4'));
    expect(s.editListTracks).toEqual([]);
    expect(s.moovBeforeMdat).toBe(true);
    expect(s.hasMoov).toBe(true);
  });
  it('refuses a file that is not an MP4', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aomv-reels-'));
    writeFileSync(join(dir, 'x.mp4'), 'this is plain text, not a video file at all');
    await expect(mp4Structure(join(dir, 'x.mp4'))).rejects.toThrow(/not an MP4/);
  });
});

const GOOD = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Duration: 00:00:10.07, start: 0.000000, bitrate: 1197 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1080x1920 [SAR 1:1 DAR 9:16], 1060 kb/s, 30 fps, 30 tbr, 15360 tbn (default)
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 122 kb/s (default)
`;
const BAD = `  Duration: 00:16:00.00, start: 0.000000, bitrate: 90000 kb/s
  Stream #0:0[0x1]: Video: vp9 (Profile 0), yuv444p(tv, bt709, progressive), 3840x2160, 30000 kb/s, 120 fps, 120 tbr, 1k tbn (default)
  Stream #0:1[0x2]: Audio: mp3, 96000 Hz, 5.1, fltp, 320 kb/s
`;

describe('parseStreamInfo', () => {
  it('reads a normal Short', () => {
    const i = parseStreamInfo(GOOD);
    expect(i.durationS).toBeCloseTo(10.07);
    expect(i.video).toMatchObject({
      codec: 'h264',
      profile: 'High',
      pixelFormat: 'yuv420p',
      progressive: true,
      width: 1080,
      height: 1920,
      fps: 30,
      kbps: 1060,
    });
    expect(i.audio).toEqual({ codec: 'aac', sampleRate: 48000, channels: 2 });
  });
  it('reads the values that break the rules', () => {
    const i = parseStreamInfo(BAD);
    expect(i.video).toMatchObject({ codec: 'vp9', pixelFormat: 'yuv444p', width: 3840, fps: 120 });
    expect(i.audio).toEqual({ codec: 'mp3', sampleRate: 96000, channels: 6 });
    expect(i.durationS).toBe(960);
  });
});

const okStructure = {
  brand: 'isom',
  topLevel: ['ftyp', 'moov', 'mdat'],
  hasMoov: true,
  moovBeforeMdat: true,
  editListTracks: [],
};
const facts = (over: Partial<ReelsFacts> = {}): ReelsFacts => ({
  bytes: 5_000_000,
  structure: okStructure,
  stream: parseStreamInfo(GOOD),
  ...over,
});

describe('evaluateReels', () => {
  it('passes a compliant file', () => {
    const c = evaluateReels(facts());
    expect(c.failed).toEqual([]);
    expect(c.passed).toBe(true);
  });
  it('lists every failed rule with the measured value', () => {
    const c = evaluateReels(
      facts({
        bytes: 400 * 1024 * 1024,
        structure: { ...okStructure, moovBeforeMdat: false, editListTracks: ['vide', 'soun'] },
        stream: parseStreamInfo(BAD),
      }),
    );
    expect(c.passed).toBe(false);
    const by = Object.fromEntries(c.failed.map((f) => [f.rule, f]));
    expect(by.edit_list?.message).toBe('edit list present (vide, soun)');
    expect(by.faststart?.message).toBe('moov not at start');
    expect(by.frame_rate?.message).toBe('frame rate 120 > 60');
    expect(by.width?.message).toBe('width 3840 > 1920');
    expect(by.duration?.message).toBe('duration 960.0 s > 900 s');
    expect(by.video_codec?.measured).toBe('vp9');
    expect(by.pixel_format?.measured).toBe('yuv444p');
    expect(by.audio_codec?.measured).toBe('mp3');
    expect(by.audio_sample_rate?.measured).toBe('96000');
    expect(by.audio_channels?.measured).toBe('6');
    expect(by.video_bitrate?.measured).toBe('30000 kb/s');
    expect(by.file_size).toBeDefined();
  });
  it('fails a frame rate under the minimum and a clip that is too short', () => {
    const s = parseStreamInfo(GOOD.replace('30 fps', '15 fps').replace('00:00:10.07', '00:00:02.00'));
    const c = evaluateReels(facts({ stream: s }));
    expect(c.failed.map((f) => f.rule).sort()).toEqual(['duration', 'frame_rate']);
  });
  it('warns, but does not fail, on a 16:9 picture', () => {
    const s = parseStreamInfo(GOOD.replace('1080x1920', '1920x1080'));
    const c = evaluateReels(facts({ stream: s }));
    expect(c.passed).toBe(true);
    expect(c.warnings).toEqual(['aspect ratio 16:9 (9:16 recommended)']);
  });
  it('takes the limits from REELS_LIMITS', () => {
    const c = evaluateReels(facts(), { ...REELS_LIMITS, fps: { min: 23, max: 25 } });
    expect(c.failed.map((f) => f.message)).toEqual(['frame rate 30 > 25']);
  });
});

describe.skipIf(!ffmpegAvailable())('checkReelsFile', () => {
  it('flags the fixture with an edit list and passes none of the structural ones but the compliant one', async () => {
    const edit = await checkReelsFile(fx('editlist.mp4'));
    expect(edit.failed.map((f) => f.rule)).toContain('edit_list');
    expect(edit.failed.map((f) => f.rule)).toContain('faststart');
    const end = await checkReelsFile(fx('moov-at-end.mp4'));
    expect(end.failed.map((f) => f.message)).toContain('moov not at start');
    expect(end.failed.map((f) => f.rule)).not.toContain('edit_list');
    // the fixture is 1 s long: only the duration rule fails
    const ok = await checkReelsFile(fx('compliant.mp4'));
    expect(ok.failed.map((f) => f.rule)).toEqual(['duration']);
    expect(ok.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('reports an unreadable file as a failed rule', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aomv-reels-'));
    writeFileSync(join(dir, 'x.mp4'), 'plain text, not a video file');
    const c = await checkReelsFile(join(dir, 'x.mp4'));
    expect(c.passed).toBe(false);
    expect(c.failed[0]?.rule).toBe('readable');
  });
  it('the final encode and toMp4 write files that pass (no edit list, moov first)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aomv-reels-'));
    const ff = findFfmpeg(RENDER_ENCODERS);
    runFfmpeg(
      [
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=1080x1920:rate=30:duration=4',
        '-c:v',
        'libx264',
        join(dir, 's0.mp4'),
      ],
      {
        bin: ff,
      },
    );
    writeSilentWav(join(dir, 'voice.wav'), 4);
    const out = join(dir, 'short.mp4');
    runFfmpeg(
      encodeArgs({
        segments: [join(dir, 's0.mp4')],
        audio: join(dir, 'voice.wav'),
        filter: '[0:v]format=yuv420p[vout]',
        crf: 30,
        fps: 30,
        seconds: 4,
        out,
      }),
      { bin: ff },
    );
    const a = await checkReelsFile(out);
    expect(a.failed).toEqual([]);
    expect(a.passed).toBe(true);

    const copy = join(dir, 'copy.mp4');
    runFfmpeg(toMp4Args(join(dir, 's0.mp4'), copy, '30'), { bin: ff });
    const b = await checkReelsFile(copy);
    expect(b.failed.map((f) => f.rule)).not.toContain('edit_list');
    expect(b.failed.map((f) => f.rule)).not.toContain('faststart');
  }, 60_000);
});
