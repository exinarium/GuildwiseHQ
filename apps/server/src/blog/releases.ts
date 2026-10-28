import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fitCaption,
  graphemeCount,
  type Release,
  type ReleaseSections,
  type ReleaseWhatsNew,
  SOCIAL_LIMITS,
  SOCIAL_POST_LIMITS,
  type SocialPostContent,
} from '@aom/shared';
import type { Ctx } from '../context.ts';

/**
 * The release manifest: what each version of the product changed, read from the files the repository already keeps.
 * - `CHANGELOG.md` (Keep a Changelog): one `## [x.y.z] - YYYY-MM-DD` section per release.
 * - the What's New entries (`apps/web/src/whats-new/entries/*.md`): the public, plain-language descriptions. An entry
 *   belongs to the release named in its optional `release:` frontmatter, else to the release whose date range holds its
 *   own date (after the previous release, up to and including this one).
 * Pure parsing is separate from file access so both are unit-tested. No database: a release is not an event.
 */

export interface ChangelogRelease {
  version: string;
  date: string;
  intro: string;
  sections: ReleaseSections;
}

const SECTION_OF: Record<string, keyof ReleaseSections> = {
  added: 'added',
  changed: 'changed',
  removed: 'changed',
  deprecated: 'changed',
  fixed: 'fixed',
  security: 'fixed',
};

/** The releases of a Keep a Changelog file, newest first (file order). `[Unreleased]` and undated sections are left out. */
export function parseChangelog(md: string): ChangelogRelease[] {
  const out: ChangelogRelease[] = [];
  let cur: ChangelogRelease | null = null;
  let section: keyof ReleaseSections | null = null;
  let intro: string[] = [];
  let item: string[] | null = null;
  const flushItem = () => {
    if (cur && section && item) cur.sections[section].push(item.join(' ').replace(/\s+/g, ' ').trim());
    item = null;
  };
  const finish = () => {
    flushItem();
    if (cur) cur.intro = intro.join(' ').replace(/\s+/g, ' ').trim();
  };
  for (const line of md.split(/\r?\n/)) {
    const h = /^##\s+\[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
    if (h) {
      finish();
      cur = null;
      section = null;
      intro = [];
      if (h[1] && /^\d+\.\d+\.\d+$/.test(h[1]) && h[2]) {
        cur = { version: h[1], date: h[2], intro: '', sections: { added: [], changed: [], fixed: [] } };
        out.push(cur);
      }
      continue;
    }
    if (!cur) continue;
    const s = /^###\s+(\w+)/.exec(line);
    if (s) {
      flushItem();
      section = SECTION_OF[(s[1] as string).toLowerCase()] ?? null;
      continue;
    }
    if (/^#{1,2}\s/.test(line)) continue;
    if (!section) {
      if (line.trim()) intro.push(line.trim());
      continue;
    }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) {
      flushItem();
      item = [b[1] as string];
    } else if (item && line.trim() && /^\s/.test(line)) item.push(line.trim());
    else if (!line.trim()) flushItem();
  }
  finish();
  return out;
}

/**
 * Text that may appear on a public page: no @handles, no issue or pull request numbers, no links into the app's Help.
 * (The changelog is public already; this keeps the page about the product, not the people or the tracker.)
 */
export function publicText(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\(\/help\/[^)]*\)/g, '$1')
    .replace(/\s*\((?:see |in )?\/help\/[^)]*\)/gi, '')
    .replace(/\s*(?:see |in )?\/help\/\S+/gi, '')
    .replace(/\s*\(#\d+(?:,\s*#\d+)*\)/g, '')
    .replace(/(^|[\s(])#\d+\b/g, '$1')
    .replace(/(^|[\s(])@[A-Za-z0-9][A-Za-z0-9_-]*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim();
}

export interface WhatsNewSource {
  id: string;
  title: string;
  date: string;
  audience: string;
  /** Frontmatter `release: 1.2.0`: pins the entry to that release whatever its date. */
  release?: string;
  body: string;
}

/** One What's New file: a small frontmatter (title, date, audience, release, help) and the body. */
export function parseWhatsNew(id: string, src: string): WhatsNewSource {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  const raw: Record<string, string> = {};
  for (const line of (m?.[1] ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    raw[line.slice(0, i).trim()] = line
      .slice(i + 1)
      .replace(/\s+#\s.*$/, '')
      .trim();
  }
  return {
    id,
    title: raw.title || id,
    date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date ?? '') ? (raw.date as string) : '1970-01-01',
    audience: raw.audience || 'all',
    ...(raw.release && /^\d+\.\d+\.\d+$/.test(raw.release) ? { release: raw.release } : {}),
    body: (m ? src.slice(m[0].length) : src).trim(),
  };
}

const PUBLIC_AUDIENCES = new Set(['all', 'owner', 'admin']);
const NO_PREVIOUS_DAYS = 14;

/**
 * The public What's New entries of a release. Platform-only (`superadmin`) entries never appear. With no previous
 * release the entries of the 14 days up to the release date count.
 */
export function whatsNewFor(
  release: { version: string; date: string },
  prevDate: string | null,
  entries: readonly WhatsNewSource[],
): ReleaseWhatsNew[] {
  const lower =
    prevDate ?? new Date(Date.parse(release.date) - NO_PREVIOUS_DAYS * 86400_000).toISOString().slice(0, 10);
  return entries
    .filter((e) => PUBLIC_AUDIENCES.has(e.audience))
    .filter((e) => (e.release ? e.release === release.version : e.date > lower && e.date <= release.date))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .map((e) => ({ id: e.id, title: publicText(e.title), date: e.date, body: publicText(e.body) }));
}

/** The manifest from the two sources, newest release first. */
export function buildReleases(changelogMd: string, entries: readonly WhatsNewSource[]): Release[] {
  const rs = parseChangelog(changelogMd);
  return rs.map((r, i) => ({
    version: r.version,
    date: r.date,
    intro: publicText(r.intro),
    sections: {
      added: r.sections.added.map(publicText),
      changed: r.sections.changed.map(publicText),
      fixed: r.sections.fixed.map(publicText),
    },
    whatsNew: whatsNewFor(r, rs[i + 1]?.date ?? null, entries),
  }));
}

// ---- files

export interface ReleaseSource {
  changelogPath: string;
  entriesDir: string;
}
const here = dirname(fileURLToPath(import.meta.url));
let override: ReleaseSource | null = null;
/** Points the manifest at other files (tests, tools). `null` restores the default. */
export function useReleaseSource(src: ReleaseSource | null): void {
  override = src;
  cache = null;
}

/**
 * Where the files are, looking from `baseDir` (the directory of this module).
 * Production: the build copies both beside the bundle (`<dist>/release-notes`), and they never change while the process
 * runs (`bundled: true`). Source tree and tests: the repository files.
 */
export function locateReleaseSource(baseDir: string): { source: ReleaseSource; bundled: boolean } | null {
  const bundled: ReleaseSource = {
    changelogPath: join(baseDir, 'release-notes', 'CHANGELOG.md'),
    entriesDir: join(baseDir, 'release-notes', 'whats-new'),
  };
  if (existsSync(bundled.changelogPath)) return { source: bundled, bundled: true };
  const repo: ReleaseSource = {
    changelogPath: join(baseDir, '../../../../CHANGELOG.md'),
    entriesDir: join(baseDir, '../../../web/src/whats-new/entries'),
  };
  return existsSync(repo.changelogPath) ? { source: repo, bundled: false } : null;
}

/** Files that can change under a running process (a repository checkout, an override) are re-read at most this often. */
const REREAD_MS = 5000;
let cache: { releases: Release[]; at: number; permanent: boolean } | null = null;

function readReleases(src: ReleaseSource): Release[] {
  if (!existsSync(src.changelogPath)) return [];
  const md = readFileSync(src.changelogPath, 'utf8');
  const files = existsSync(src.entriesDir)
    ? readdirSync(src.entriesDir)
        .filter((f) => f.endsWith('.md') && !/readme/i.test(f))
        .sort()
    : [];
  const entries = files.map((f) =>
    parseWhatsNew(f.replace(/\.md$/, ''), readFileSync(join(src.entriesDir, f), 'utf8')),
  );
  return buildReleases(md, entries);
}

/**
 * Every release, newest first. Empty when the files are missing (a deployment without them has no release posts).
 * Called on every public page request, so the result is kept: for good when the files are the bundled ones (immutable),
 * else for a few seconds.
 */
export function loadReleases(_ctx?: Ctx): Release[] {
  const now = Date.now();
  if (cache && (cache.permanent || now - cache.at < REREAD_MS)) return cache.releases;
  const found = override ? { source: override, bundled: false } : locateReleaseSource(here);
  const releases = found ? readReleases(found.source) : [];
  cache = { releases, at: now, permanent: !!found?.bundled && releases.length > 0 };
  return releases;
}

export const getRelease = (version: string, ctx?: Ctx): Release | undefined =>
  loadReleases(ctx).find((r) => r.version === version);

// ---- the by-hand starting point

const plain = (s: string): string =>
  publicText(s)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The first sentence of an item, cut at a word boundary. */
function headline(item: string, max: number): string {
  const t = plain(item);
  const first = /^(.+?[.!?])(\s|$)/.exec(t)?.[1] ?? t;
  return fitCaption(first, max).replace(/[.…]+$/, '');
}

/** Intro, as many of the headlines as fit 700 graphemes (whole lines, never a cut sentence), and the closing line. */
function linkedinText(version: string, top: string[]): string {
  const max = SOCIAL_LIMITS.linkedin.text;
  const head = `Guildwise HQ ${version} is out.`;
  const tail = '\n\nThe full list is on the release page.';
  const kept: string[] = [];
  for (const t of top) {
    const next = `${head}\n\nWhat is new:\n${[...kept, `- ${t}`].join('\n')}${tail}`;
    if (graphemeCount(next) > max) break;
    kept.push(`- ${t}`);
  }
  return `${head}${kept.length ? `\n\nWhat is new:\n${kept.join('\n')}` : ''}${tail}`;
}

/**
 * Captions prefilled from the manifest for a super admin who writes the post by hand (and a valid starting point for any
 * drafter): factual, no hype, no link (the link is added per network). The hashtags are a suggestion.
 */
export function draftFromRelease(r: Release): SocialPostContent {
  const items = [...r.sections.added, ...r.sections.changed].filter((i) => plain(i).length > 10);
  const top = items.slice(0, 3).map((i) => headline(i, 110));
  const lead = top[0] ?? 'See what changed in this release';
  const list = top.map((t) => `- ${t}`).join('\n');
  const summary = fitCaption(
    `Guildwise HQ ${r.version} is out. ${top.length ? `${top.join('. ')}.` : 'See what changed in this release.'}`,
    SOCIAL_POST_LIMITS.summaryMax,
  );
  return {
    version: r.version,
    releasedOn: r.date,
    title: fitCaption(`Guildwise HQ ${r.version}: ${lead}`, SOCIAL_POST_LIMITS.titleMax),
    summary,
    coverKey: 'release',
    captions: {
      facebookText: fitCaption(`Guildwise HQ ${r.version} is out. ${top.slice(0, 2).join('. ')}.`, 500),
      linkedinText: linkedinText(r.version, top),
      xText: fitCaption(`Guildwise HQ ${r.version} is out. ${lead}.`, 200),
      blueskyText: fitCaption(`Guildwise HQ ${r.version} is out. ${lead}.`, 240),
      hashtags: {
        facebook: ['GuildwiseHQ'],
        linkedin: ['AIAgents', 'Automation', 'GuildwiseHQ'],
        x: ['GuildwiseHQ'],
        bluesky: ['GuildwiseHQ'],
      },
    },
  };
}
