import { z } from 'zod';

/** Limits of a generated video and of its YouTube metadata. */
export const VIDEO_LIMITS = {
  youtube: {
    title: 100,
    descriptionBytes: 5000,
    tagsChars: 500,
    hashtags: [3, 5] as readonly [number, number],
  },
  /** Narrated words per format (about 2.4 words a second). */
  words: { long: [120, 650] as readonly [number, number], short: [70, 140] as readonly [number, number] },
  /** Rendered output never exceeds this (seconds); Shorts stay under three minutes. */
  maxSeconds: { long: 600, short: 180 },
  codeLines: 12,
  pointItems: 4,
  /** Silence after every cue (seconds). */
  cueGapSeconds: 0.7,
} as const;

export const VIDEO_KINDS = ['article', 'release', 'tutorial'] as const;
export const VIDEO_FORMATS = ['long', 'short'] as const;
export type VideoKind = (typeof VIDEO_KINDS)[number];
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

const text = (max: number) => z.string().trim().min(1).max(max);

export const VideoSceneSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('title'), heading: text(120), sub: text(200).optional() }),
  z.object({
    type: z.literal('points'),
    heading: text(120),
    items: z.array(text(140)).min(1).max(VIDEO_LIMITS.pointItems),
  }),
  z.object({ type: z.literal('quote'), text: text(300) }),
  z.object({
    type: z.literal('code'),
    lang: text(20),
    code: z
      .string()
      .min(1)
      .max(1200)
      .refine(
        (c) => c.split('\n').length <= VIDEO_LIMITS.codeLines,
        `at most ${VIDEO_LIMITS.codeLines} lines`,
      ),
  }),
  // a help video chapter (index into its chapters, or its title) or an explicit range in seconds
  z.object({
    type: z.literal('clip'),
    slug: text(80),
    chapter: z.union([z.number().int().min(0), text(120)]).optional(),
    from: z.number().min(0).optional(),
    to: z.number().positive().optional(),
  }),
  z.object({
    type: z.literal('image'),
    src: z.enum(['cover', 'release', 'logo']),
    caption: text(160).optional(),
  }),
  z.object({ type: z.literal('outro'), heading: text(120).optional(), sub: text(200).optional() }),
]);
export type VideoScene = z.infer<typeof VideoSceneSchema>;

export const VideoCueSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase id'),
  text: text(600),
  /** Overrides `speakable(text)` when given. */
  speech: text(900).optional(),
  scene: VideoSceneSchema,
});
export type VideoCue = z.infer<typeof VideoCueSchema>;

const noAngle = (s: string) => !/[<>]/.test(s);

export const VideoMetaSchema = z.object({
  title: text(VIDEO_LIMITS.youtube.title).refine(noAngle, 'no < or >'),
  /** The hook: the opening lines of the description (the builder adds link, chapters and the rest). */
  description: text(1500).refine(noAngle, 'no < or >'),
  tags: z
    .array(text(60).refine(noAngle, 'no < or >'))
    .max(30)
    .refine((t) => t.join(',').length <= VIDEO_LIMITS.youtube.tagsChars, 'tags too long'),
  hashtags: z
    .array(z.string().regex(/^#[A-Za-z0-9_]{2,40}$/))
    .min(VIDEO_LIMITS.youtube.hashtags[0])
    .max(VIDEO_LIMITS.youtube.hashtags[1]),
});
export type VideoMeta = z.infer<typeof VideoMetaSchema>;

export const VideoScriptSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(VIDEO_KINDS),
    format: z.enum(VIDEO_FORMATS),
    /** The article slug, release version or topic id the video is about (for the description link). */
    ref: text(120).optional(),
    title: text(VIDEO_LIMITS.youtube.title),
    cues: z.array(VideoCueSchema).min(1).max(80),
    chapters: z.array(z.object({ title: text(80), fromCue: z.number().int().min(0) })).max(20),
    meta: VideoMetaSchema,
  })
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    s.cues.forEach((c, i) => {
      if (ids.has(c.id))
        ctx.addIssue({ code: 'custom', path: ['cues', i, 'id'], message: 'duplicate cue id' });
      ids.add(c.id);
    });
    s.cues.forEach((c, i) => {
      const sc = c.scene;
      if (sc.type !== 'clip') return;
      const range = sc.from !== undefined || sc.to !== undefined;
      const ok =
        sc.chapter !== undefined ? !range : sc.from !== undefined && sc.to !== undefined && sc.to > sc.from;
      if (!ok)
        ctx.addIssue({
          code: 'custom',
          path: ['cues', i, 'scene'],
          message: 'a clip needs a chapter, or from and to (to after from)',
        });
    });
    let prev = -1;
    s.chapters.forEach((ch, i) => {
      if (ch.fromCue >= s.cues.length || ch.fromCue <= prev)
        ctx.addIssue({
          code: 'custom',
          path: ['chapters', i, 'fromCue'],
          message: 'chapters must rise and point at a cue',
        });
      prev = ch.fromCue;
    });
    if (s.format === 'long') {
      if (s.chapters.length < 3)
        ctx.addIssue({
          code: 'custom',
          path: ['chapters'],
          message: 'a long video needs at least 3 chapters',
        });
      else if (s.chapters[0]?.fromCue !== 0)
        ctx.addIssue({
          code: 'custom',
          path: ['chapters', 0, 'fromCue'],
          message: 'the first chapter starts at cue 0',
        });
    }
  });
export type VideoScript = z.infer<typeof VideoScriptSchema>;

export interface VideoValidationContext {
  /** Slugs of the help videos clips may use. */
  clipSlugs: Iterable<string>;
}

const DEMO_LEAK = /\b(?:Acme|Alex Morgan)\b|example\.com|demo\.local/i;

export function countWords(script: Pick<VideoScript, 'cues'>): number {
  return script.cues.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0);
}

/** Semantic checks beyond the shape: clip slugs, the word range of the format, no demo data in the narration. */
export function videoScriptIssues(script: VideoScript, ctx: VideoValidationContext): string[] {
  const issues: string[] = [];
  const slugs = new Set(ctx.clipSlugs);
  script.cues.forEach((c) => {
    if (c.scene.type === 'clip' && !slugs.has(c.scene.slug))
      issues.push(`cue ${c.id}: unknown clip video "${c.scene.slug}"`);
    if (DEMO_LEAK.test(c.text) || (c.speech && DEMO_LEAK.test(c.speech)))
      issues.push(`cue ${c.id}: demo data in the narration`);
  });
  const words = countWords(script);
  const [min, max] = VIDEO_LIMITS.words[script.format];
  if (words < min || words > max)
    issues.push(`${words} words; a ${script.format} video needs ${min} to ${max}`);
  return issues;
}

export type ParsedVideoScript = { ok: true; script: VideoScript } | { ok: false; issues: string[] };

/** Parses and validates a script from JSON. */
export function parseVideoScript(input: unknown, ctx: VideoValidationContext): ParsedVideoScript {
  const r = VideoScriptSchema.safeParse(input);
  if (!r.success)
    return { ok: false, issues: r.error.issues.map((i) => `${i.path.join('.') || 'script'}: ${i.message}`) };
  const issues = videoScriptIssues(r.data, ctx);
  return issues.length ? { ok: false, issues } : { ok: true, script: r.data };
}
