import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildDescription,
  chapterStamp,
  numberToWords,
  parseVideoScript,
  speakable,
  VIDEO_LIMITS,
  type VideoScript,
  videoLink,
} from '../src/index.ts';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../video/test/fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as VideoScript;

describe('speakable', () => {
  it('speaks versions in words and drops trailing zero parts', () => {
    expect(speakable('Release 1.2.0 is out')).toBe('Release version one point two is out');
    expect(speakable('Upgrade to v1.2.3 today')).toBe('Upgrade to version one point two point three today');
    expect(speakable('Guildwise HQ 1.0 ships')).toBe('Guildwise H Q version one ships');
    expect(speakable('version 2.10.1')).toBe('version two point ten point one');
  });
  it('applies the pronunciation map to names', () => {
    expect(speakable('Guildwise HQ talks to Postgres through aom-runner')).toBe(
      'Guildwise H Q talks to post-gres through the runner',
    );
    expect(speakable('GuildwiseHQ and PostgreSQL')).toBe('Guildwise H Q and post-gres');
  });
  it('strips URLs, markdown and symbols', () => {
    expect(
      speakable('Read [the docs](https://guildwisehq.com/docs) at https://guildwisehq.com/blog now'),
    ).toBe('Read the docs at now');
    expect(speakable('Run `pnpm build` and **ship** it')).toBe('Run pnpm build and ship it');
    expect(speakable('Plan -> build, e.g. fast')).toBe('Plan to build, for example fast');
  });
  it('speaks numbers, decimals, percents and years', () => {
    expect(speakable('You get 3 agents and 25% off')).toBe(
      'You get three agents and twenty-five percent off',
    );
    expect(speakable('It takes 2.5 seconds')).toBe('It takes two point five seconds');
    expect(speakable('Since 2026')).toBe('Since twenty twenty-six');
    expect(speakable('1,200 cards')).toBe('one thousand two hundred cards');
  });
  it('leaves identifiers with digits alone and is deterministic', () => {
    expect(speakable('Use H264 and af_heart')).toBe('Use H264 and af_heart');
    expect(speakable('A 7 B')).toBe(speakable('A 7 B'));
  });
  it('numberToWords', () => {
    expect(numberToWords(0)).toBe('zero');
    expect(numberToWords(42)).toBe('forty-two');
    expect(numberToWords(105)).toBe('one hundred five');
    expect(numberToWords(1_000_001)).toBe('one million one');
  });
});

describe('video script schema', () => {
  const ctx = { clipSlugs: ['agents', 'board'] };
  it('accepts the fixtures', () => {
    for (const f of ['agents-long', 'agents-short']) {
      const r = parseVideoScript(fixture(f), ctx);
      expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    }
  });
  it('rejects a clip of a video that does not exist', () => {
    const s = fixture('agents-long');
    const r = parseVideoScript(
      {
        ...s,
        cues: s.cues.map((c, i) =>
          i === 2 ? { ...c, scene: { type: 'clip', slug: 'nope', chapter: 0 } } : c,
        ),
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toContain('unknown clip video "nope"');
  });
  it('enforces the word range of the format', () => {
    const s = fixture('agents-short');
    const long = {
      ...s,
      format: 'long',
      chapters: [
        { title: 'a', fromCue: 0 },
        { title: 'b', fromCue: 1 },
        { title: 'c', fromCue: 2 },
      ],
    };
    const r = parseVideoScript(long, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/words; a long video needs 120 to/);
    const tiny = { ...s, cues: s.cues.slice(0, 1) };
    expect(parseVideoScript(tiny, ctx).ok).toBe(false);
  });
  it('checks chapters, clips, code length, hashtags and demo data', () => {
    const s = fixture('agents-long');
    expect(parseVideoScript({ ...s, chapters: s.chapters.slice(0, 2) }, ctx).ok).toBe(false);
    expect(
      parseVideoScript({ ...s, chapters: [{ title: 'x', fromCue: 1 }, ...s.chapters.slice(1)] }, ctx).ok,
    ).toBe(false);
    const clip = (scene: object) => ({ ...s, cues: s.cues.map((c, i) => (i === 2 ? { ...c, scene } : c)) });
    expect(parseVideoScript(clip({ type: 'clip', slug: 'agents' }), ctx).ok).toBe(false);
    expect(parseVideoScript(clip({ type: 'clip', slug: 'agents', from: 5, to: 3 }), ctx).ok).toBe(false);
    expect(parseVideoScript(clip({ type: 'clip', slug: 'agents', from: 3, to: 9 }), ctx).ok).toBe(true);
    const code = (n: number) => ({
      ...s,
      cues: s.cues.map((c, i) =>
        i === 7 ? { ...c, scene: { type: 'code', lang: 'ts', code: Array(n).fill('x').join('\n') } } : c,
      ),
    });
    expect(parseVideoScript(code(12), ctx).ok).toBe(true);
    expect(parseVideoScript(code(13), ctx).ok).toBe(false);
    expect(parseVideoScript({ ...s, meta: { ...s.meta, hashtags: ['#a1', '#b2'] } }, ctx).ok).toBe(false);
    expect(
      parseVideoScript({ ...s, meta: { ...s.meta, title: 'x'.repeat(VIDEO_LIMITS.youtube.title + 1) } }, ctx)
        .ok,
    ).toBe(false);
    expect(parseVideoScript({ ...s, meta: { ...s.meta, title: 'a <b>' } }, ctx).ok).toBe(false);
    const leak = {
      ...s,
      cues: s.cues.map((c, i) => (i === 0 ? { ...c, text: `${c.text} Ask Alex Morgan at Acme.` } : c)),
    };
    const r = parseVideoScript(leak, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toContain('demo data');
  });
});

describe('description builder', () => {
  const s = fixture('agents-long');
  const chapters = [
    { title: 'Introduction', start: 0 },
    { title: 'Hire', start: 15.2 },
    { title: 'Pause', start: 30 },
    { title: 'Wrap', start: 66 },
  ];
  it('builds hook, UTM link, chapters at 00:00, repo, synthetic voice line and hashtags last', () => {
    const d = buildDescription({ ...s, kind: 'article', ref: 'my-post' }, chapters, 72);
    expect(d.startsWith(s.meta.description)).toBe(true);
    expect(d).toContain(
      'https://guildwisehq.com/blog/my-post?utm_source=youtube&utm_medium=video&utm_campaign=article-my-post',
    );
    expect(d).toContain('00:00 Introduction\n00:15 Hire\n00:30 Pause');
    expect(d).not.toContain('Wrap'); // 6s: merged away
    expect(d).toContain('github.com/exinarium/GuildwiseHQ');
    expect(d).toContain('Narrated with a synthetic voice.');
    expect(d.trim().endsWith(s.meta.hashtags.join(' '))).toBe(true);
    expect(Buffer.byteLength(d)).toBeLessThanOrEqual(VIDEO_LIMITS.youtube.descriptionBytes);
  });
  it('omits chapters that cannot satisfy YouTube and links releases', () => {
    const d = buildDescription({ ...s, kind: 'release', ref: '1.2.0' }, chapters.slice(0, 2), 72);
    expect(d).not.toContain('00:00');
    expect(videoLink('release', '1.2.0')).toBe(
      'https://guildwisehq.com/releases/1.2.0?utm_source=youtube&utm_medium=video&utm_campaign=release-1.2.0',
    );
  });
  it('formats chapter stamps', () => {
    expect(chapterStamp(0)).toBe('00:00');
    expect(chapterStamp(75.9)).toBe('01:15');
    expect(chapterStamp(3725)).toBe('1:02:05');
  });
});
