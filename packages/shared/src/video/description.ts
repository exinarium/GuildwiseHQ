import type { VideoKind, VideoScript } from './schema.ts';
import { VIDEO_LIMITS } from './schema.ts';

export const SITE_ORIGIN = 'https://guildwisehq.com';
export const REPO_URL = 'https://github.com/exinarium/GuildwiseHQ';
export const SYNTHETIC_VOICE_LINE = 'Narrated with a synthetic voice.';

/** `m:ss`, or `h:mm:ss` from an hour; YouTube chapters want 00:00 style, so minutes are padded. */
export function chapterStamp(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const p = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(t / 3600);
  return h > 0 ? `${h}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}` : `${p(Math.floor(t / 60))}:${p(t % 60)}`;
}

/** The page the video points at, with UTM tags; null for a kind without a page of its own. */
export function videoLink(kind: VideoKind, ref: string | undefined): string | null {
  if (!ref) return null;
  const utm = (campaign: string) => `?utm_source=youtube&utm_medium=video&utm_campaign=${campaign}-${ref}`;
  if (kind === 'article') return `${SITE_ORIGIN}/blog/${ref}${utm('article')}`;
  if (kind === 'release') return `${SITE_ORIGIN}/releases/${ref}${utm('release')}`;
  return `${SITE_ORIGIN}/${utm('tutorial')}`;
}

export interface DescriptionChapter {
  title: string;
  /** Seconds into the video. */
  start: number;
}

/**
 * The YouTube description: hook, link, chapters (only when at least 3 remain that start at 00:00 and are 10s or
 * longer), repo link, the synthetic voice line, hashtags last. Trimmed to the byte limit by dropping chapters first.
 */
export function buildDescription(
  script: Pick<VideoScript, 'kind' | 'ref' | 'meta'>,
  chapters: DescriptionChapter[],
  totalSeconds: number,
): string {
  const link = videoLink(script.kind, script.ref);
  // YouTube wants every chapter at least 10s: a shorter one is merged into the one before it (the first into the next)
  const kept = [...chapters];
  const len = (i: number) => (kept[i + 1]?.start ?? totalSeconds) - (kept[i]?.start ?? 0);
  for (let i = 0; i < kept.length; i++) {
    if (len(i) >= 10) continue;
    if (kept.length <= 1) break; // nothing to merge into (it would loop for ever)
    kept.splice(i === 0 ? 1 : i, 1);
    i = -1;
  }
  const usable = kept.length >= 3 && kept[0]?.start === 0;
  const parts: string[] = [script.meta.description.trim()];
  if (link)
    parts.push(
      `${script.kind === 'release' ? 'Release notes' : script.kind === 'article' ? 'Read the article' : 'Learn more'}: ${link}`,
    );
  if (usable) parts.push(kept.map((c) => `${chapterStamp(c.start)} ${c.title}`).join('\n'));
  parts.push(`Source code: ${REPO_URL}`, SYNTHETIC_VOICE_LINE, script.meta.hashtags.join(' '));
  let out = parts.join('\n\n');
  if (Buffer.byteLength(out) > VIDEO_LIMITS.youtube.descriptionBytes) {
    const hook = script.meta.description.trim().slice(0, 800);
    out = [hook, ...parts.slice(1).filter((p) => !p.startsWith('00:00'))].join('\n\n');
  }
  return out.replace(/[<>]/g, '');
}
