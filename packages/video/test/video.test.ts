import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoScript } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  chunkCaption,
  findFfmpeg,
  fitClip,
  joinWavs,
  probeDuration,
  RENDER_ENCODERS,
  renderVideo,
  sceneHtml,
  srt,
  streamDurations,
  voiceAvailable,
  vtt,
  wavSeconds,
  writeSilentWav,
  xfadeOffsets,
} from '../src/index.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as VideoScript;

describe('timeline', () => {
  const s = fixture('agents-long');
  const durations = s.cues.map((_, i) => 3 + i);
  const tl = buildTimeline(s, durations, 0.7);
  it('starts each cue after the earlier cues and their gaps', () => {
    expect(tl.cues[0]).toMatchObject({ start: 0, end: 3 });
    expect(tl.cues[1]?.start).toBeCloseTo(3.7);
    expect(tl.cues[2]?.start).toBeCloseTo(3.7 + 4.7);
    expect(tl.total).toBeCloseTo(durations.reduce((a, b) => a + b, 0) + 0.7 * durations.length);
  });
  it('merges consecutive cues with the same scene and keeps the total', () => {
    expect(tl.segments.length).toBe(s.cues.length - 1); // hire1 + hire2 share one clip
    expect(tl.segments.reduce((a, x) => a + x.duration, 0)).toBeCloseTo(tl.total);
    expect(tl.segments[2]?.cueCount).toBe(2);
  });
  it('places chapters at the start of their cue', () => {
    expect(tl.chapters.map((c) => c.start)[0]).toBe(0);
    expect(tl.chapters[1]?.start).toBeCloseTo(tl.cues[2]?.start ?? -1);
  });
  it('lengths and xfade offsets add up to the total with 0.3s fades', () => {
    const lens = streamDurations(tl);
    const fades = lens.length - 1;
    expect(lens.reduce((a, b) => a + b, 0) - fades * 0.3).toBeCloseTo(tl.total);
    const offs = xfadeOffsets(tl);
    // each fade starts where the stream built so far (minus earlier fades) ends minus the fade
    let acc = lens[0] as number;
    offs.forEach((o, i) => {
      expect(o).toBeCloseTo(acc - 0.3);
      acc += (lens[i + 1] as number) - 0.3;
    });
  });
});

describe('clip fitting', () => {
  it('trims a long clip', () => expect(fitClip(10, 25)).toEqual({ speed: 1, take: 10, freeze: 0 }));
  it('slows a slightly short clip to fit', () => {
    const f = fitClip(10, 8.5);
    expect(f.speed).toBeCloseTo(0.85);
    expect(f.freeze).toBeCloseTo(0);
  });
  it('never slows below 0.8 and freezes the rest', () => {
    const f = fitClip(10, 4);
    expect(f.speed).toBe(0.8);
    expect(f.freeze).toBeCloseTo(10 - 5);
  });
});

describe('captions', () => {
  const cues = [
    { start: 0, end: 2.5, text: 'Hello there.' },
    { start: 3661.007, end: 3662.5, text: 'Later' },
  ];
  it('writes WebVTT with dot milliseconds', () => {
    expect(vtt(cues)).toBe(
      'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\nHello there.\n\n2\n01:01:01.007 --> 01:01:02.500\nLater\n',
    );
  });
  it('writes SRT with comma milliseconds', () => {
    expect(srt(cues)).toBe(
      '1\n00:00:00,000 --> 00:00:02,500\nHello there.\n\n2\n01:01:01,007 --> 01:01:02,500\nLater\n',
    );
  });
  it('chunks Short captions to a few words spanning the cue', () => {
    const chunks = chunkCaption({ start: 10, end: 16, text: 'You stay in charge of what ships, always.' });
    expect(chunks.every((c) => c.text.split(' ').length <= 5)).toBe(true);
    expect(chunks[0]?.start).toBe(10);
    expect(chunks[chunks.length - 1]?.end).toBe(16);
    for (const [i, c] of chunks.slice(1).entries()) expect(c.start).toBeCloseTo(chunks[i]?.end ?? -1);
  });
});

describe('audio', () => {
  it('joins recordings with silence between them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aomv-'));
    writeSilentWav(join(dir, 'a.wav'), 1.5);
    writeSilentWav(join(dir, 'b.wav'), 2);
    joinWavs([join(dir, 'a.wav'), join(dir, 'b.wav')], 0.7, join(dir, 'all.wav'));
    expect(wavSeconds(join(dir, 'all.wav'))).toBeCloseTo(1.5 + 2 + 1.4, 3);
  });
});

function ffmpegAvailable(): boolean {
  try {
    findFfmpeg(RENDER_ENCODERS);
    return true;
  } catch {
    return false;
  }
}
const canRender = voiceAvailable() && ffmpegAvailable() && !!process.env.AOM_VIDEO_RENDER_TEST;

describe.skipIf(!canRender)(
  'render smoke (needs the Kokoro voice, ffmpeg and Chromium; set AOM_VIDEO_RENDER_TEST=1)',
  () => {
    it('renders a Short: duration is the cues plus gaps, with captions and no thumbnail', async () => {
      const s = fixture('agents-short');
      const noClips: VideoScript = {
        ...s,
        cues: s.cues.map((c) =>
          c.scene.type === 'clip' ? { ...c, scene: { type: 'quote' as const, text: 'Placeholder' } } : c,
        ),
      };
      const out = mkdtempSync(join(tmpdir(), 'aomv-render-'));
      const r = await renderVideo(noClips, { outDir: out });
      const spoken = r.timeline.cues.reduce((a, c) => a + (c.end - c.start), 0);
      expect(r.durationSeconds).toBeGreaterThan(spoken + noClips.cues.length * 0.7 - 0.5);
      expect(r.durationSeconds).toBeLessThan(spoken + noClips.cues.length * 0.7 + 0.5);
      expect(r.width).toBe(1080);
      expect(statSync(r.artifacts.video).size).toBeGreaterThan(10_000);
      expect(probeDuration(r.artifacts.video)).toBeCloseTo(r.durationSeconds, 1);
      expect(r.artifacts.thumb).toBeNull();
      expect(readFileSync(r.artifacts.captionsVtt, 'utf8').startsWith('WEBVTT')).toBe(true);
    }, 180_000);
  },
);

describe('code card language label', () => {
  const card = (lang: string) => sceneHtml({ type: 'code', lang, code: 'a = 1' }, 'landscape');
  it('shows the language of real code', () => {
    expect(card('ts')).toContain('<div class="lang">ts</div>');
  });
  it('hides the label for plain text', () => {
    for (const lang of ['text', 'TEXT', 'plain', 'plaintext', 'txt', 'none'])
      expect(card(lang)).not.toContain('class="lang"');
    expect(card('text')).toContain('<pre>a = 1</pre>');
  });
});
