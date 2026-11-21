import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BlogContent } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/auth/secrets.ts';
import { exportBundle, extract } from '../src/blog/bundle/export.ts';
import { applyImport, BundleRefused, loadBundle, planImport } from '../src/blog/bundle/import.ts';
import { decodeCopyField, readDumpTables } from '../src/blog/bundle/pgdump.ts';
import { checkPostContent, checkShare } from '../src/blog/bundle/sanitize.ts';
import { blogSettings } from '../src/commands/blog.ts';
import { socialTick } from '../src/commands/social.ts';
import {
  articlesNeedingVideo,
  importLibrary,
  publicVideoEmbed,
  releasesNeedingVideo,
} from '../src/commands/video-posts.ts';
import { migrateBlogLaunch } from '../src/data-migrations/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import type { VideoDestinationClient } from '../src/video/destinations.ts';
import { videoTick } from '../src/video/sweep.ts';
import type { YouTubeClient } from '../src/video/youtube.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { blogContent, FakeSocial } from './helpers/blog.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

// ---- a fixture dump in plain pg_dump format: real headers, fake secrets that must never reach a bundle

const SECRETS = [
  '$argon2id$v=19$m=65536,t=3,p=4$FAKESALTblogcarry$FAKEHASHblogcarry',
  'FAKE-ACCESS-TOKEN-blogcarry-0123',
  'FAKE-REFRESH-TOKEN-blogcarry-4567',
  'aomk_FAKEKEYblogcarry89',
  'https://upload.fake.test/session-SECRET-blogcarry',
  'FAKE-DEST-TOKEN-blogcarry',
  'owner-blogcarry@fake.test',
];

const enc = (v: unknown): string => {
  if (v === null || v === undefined) return '\\N';
  const s = typeof v === 'string' ? v : typeof v === 'boolean' ? (v ? 't' : 'f') : JSON.stringify(v);
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
};
const copy = (table: string, cols: string[], rows: Array<Record<string, unknown>>) =>
  [
    `COPY public.${table} (${cols.join(', ')}) FROM stdin;`,
    ...rows.map((r) => cols.map((c) => enc(r[c])).join('\t')),
    '\\.',
    '',
  ].join('\n');

const BLOG_COLS = [
  'id',
  'slug',
  'content',
  'title',
  'summary',
  'tags',
  'status',
  'rejection_reason',
  'content_hash',
  'origin_key_id',
  'origin_user_id',
  'warnings',
  'word_count',
  'reading_minutes',
  'review_since',
  'published_at',
  'created_at',
  'updated_at',
  'launch',
  'origin_system',
  'origin_kind',
  'author_name',
];
const SOCIAL_COLS = [
  'id',
  'kind',
  'ref',
  'content',
  'title',
  'status',
  'rejection_reason',
  'origin_user_id',
  'origin_system',
  'review_since',
  'approved_at',
  'created_at',
  'updated_at',
];
const SHARE_COLS = [
  'post_id',
  'network',
  'status',
  'attempts',
  'next_attempt_at',
  'external_id',
  'url',
  'error',
  'created_at',
  'updated_at',
  'source',
  'detail',
];
const VIDEO_COLS = [
  'id',
  'kind',
  'format',
  'ref',
  'parent_id',
  'script',
  'meta',
  'title',
  'revision',
  'status',
  'approved_render_id',
  'rejection_reason',
  'origin_user_id',
  'origin_system',
  'review_since',
  'approved_at',
  'created_at',
  'updated_at',
  'slot_at',
  'publish_mode',
  'destinations',
  'captions',
  'destination_options',
  'slipped_at',
  'submit_captions',
];

/** `2026-11-03 06:00:45.123456+00`: how COPY writes a timestamptz. */
const pgTs = (d: Date) => `${d.toISOString().replace('T', ' ').replace('Z', '')}456+00`;
const hash = (c: BlogContent) => createHash('sha256').update(`${c.title}\n${c.bodyMarkdown}`).digest('hex');
const meta = (title: string) => ({
  title,
  description: 'Hire an AI teammate in Guildwise HQ in under a minute.',
  tags: ['Guildwise HQ', 'AI agents'],
  hashtags: ['#Shorts', '#AIAgents', '#GuildwiseHQ'],
});
const releaseContent = (version: string) => ({
  version,
  releasedOn: '2026-10-20',
  title: `Guildwise HQ ${version} is out now`,
  summary: 'What changed in this release of Guildwise HQ, in one short paragraph for the link card.',
  coverKey: 'release',
  captions: { facebookText: `Guildwise HQ ${version} is out.` },
});

const ids = {
  user: randomUUID(),
  key: randomUUID(),
  a: randomUUID(),
  manual: randomUUID(),
  launch: randomUUID(),
  draft: randomUUID(),
  rejected: randomUUID(),
  rel: randomUUID(),
  relRejected: randomUUID(),
  long: randomUUID(),
  short: randomUUID(),
  lib: randomUUID(),
  vDraft: randomUUID(),
  vFailed: randomUUID(),
  relVideo: randomUUID(),
};
const HOUR = 3600_000;
const published = new Date(Date.now() - HOUR); // fresh: the share sweep would take it if it were not a launch post
const created = new Date(Date.now() - 3 * HOUR);
const old = new Date(Date.now() - 10 * 24 * HOUR);
const contentA = blogContent('carried-agents', {
  title: 'Carried over: how teams use agents with a \\ and a\ttab',
});
const contentManual = { ...blogContent('carried-manual'), aiDisclosure: undefined } as unknown as BlogContent;
const contentLaunch = blogContent('what-is-an-ai-agent-team');

function blogRow(id: string, c: BlogContent, status: string, over: Record<string, unknown> = {}) {
  return {
    id,
    slug: c.slug,
    content: c,
    title: c.title,
    summary: c.summary,
    tags: `{${c.tags.join(',')}}`,
    status,
    content_hash: hash(c),
    origin_key_id: ids.key,
    origin_user_id: ids.user,
    warnings: [],
    word_count: 100,
    reading_minutes: 1,
    published_at: status === 'published' ? pgTs(published) : null,
    created_at: pgTs(created),
    updated_at: pgTs(published),
    launch: false,
    origin_system: 'blog-writer',
    origin_kind: 'writer',
    author_name: null,
    ...over,
  };
}
const shareRow = (
  postId: string,
  network: string,
  status: string,
  source: string,
  over: Record<string, unknown> = {},
) => ({
  post_id: postId,
  network,
  status,
  attempts: 1,
  external_id: status === 'sent' ? null : null,
  url: null,
  error: status === 'failed' ? `token ${SECRETS[1]} rejected` : null,
  created_at: pgTs(published),
  updated_at: pgTs(published),
  source,
  detail: null,
  ...over,
});
const videoRow = (
  id: string,
  kind: string,
  format: string,
  ref: string,
  status: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  kind,
  format,
  ref,
  parent_id: null,
  script: { secret: SECRETS[5] },
  meta: meta(`Video ${ref} ${format}`),
  title: `Video ${ref} ${format}`,
  revision: 1,
  status,
  approved_render_id: randomUUID(),
  origin_user_id: ids.user,
  origin_system: 'blog-writer',
  approved_at: status === 'approved' ? pgTs(created) : null,
  created_at: pgTs(created),
  updated_at: pgTs(published),
  slot_at: pgTs(published),
  publish_mode: 'slot',
  destinations: '{youtube,facebook,x}',
  captions: null,
  destination_options: { tiktok: { token: SECRETS[5] } },
  slipped_at: null,
  submit_captions: null,
  ...over,
});

function fixtureDump(variant: { extraRow?: boolean; changeA?: boolean } = {}): string {
  const yt = (videoId: string) => ({
    videoId,
    privacy: 'public',
    publishAt: published.toISOString(),
    verifiedAt: published.toISOString(),
    uploadedAt: created.toISOString(),
    sessionUri: SECRETS[4],
    steps: { upload: 'ok' },
    dest: { token: SECRETS[5] },
    rerender: { revision: 2 },
  });
  const blog = [
    blogRow(
      ids.a,
      variant.changeA ? { ...contentA, summary: `${contentA.summary} Changed later.` } : contentA,
      'published',
    ),
    blogRow(ids.manual, contentManual, 'published', {
      origin_kind: 'manual',
      author_name: 'Ada Writer',
      origin_system: null,
      origin_key_id: null,
    }),
    blogRow(ids.launch, contentLaunch, 'published', {
      launch: true,
      origin_system: null,
      origin_key_id: null,
      origin_user_id: null,
    }),
    blogRow(ids.draft, blogContent('carried-draft'), 'draft'),
    blogRow(ids.rejected, blogContent('carried-rejected'), 'rejected', { rejection_reason: 'no' }),
    ...(variant.extraRow ? [blogRow(randomUUID(), blogContent('late-in-review'), 'in_review')] : []),
  ];
  const social = [
    {
      id: ids.rel,
      kind: 'release',
      ref: '1.2.0',
      content: releaseContent('1.2.0'),
      title: 'r',
      status: 'approved',
      origin_user_id: ids.user,
      // fresh, like the article: the share sweep would take it for every connected network were it not carried over
      approved_at: pgTs(published),
      created_at: pgTs(old),
      updated_at: pgTs(old),
    },
    {
      id: ids.relRejected,
      kind: 'release',
      ref: '1.3.0',
      content: releaseContent('1.3.0'),
      title: 'r',
      status: 'rejected',
      rejection_reason: 'no',
      created_at: pgTs(old),
      updated_at: pgTs(old),
    },
  ];
  const videos = [
    videoRow(ids.long, 'article', 'long', contentA.slug, 'approved'),
    videoRow(ids.short, 'article', 'short', contentA.slug, 'approved', { parent_id: ids.long }),
    videoRow(ids.lib, 'tutorial', 'long', 'lib:overview', 'approved', {
      script: null,
      destinations: '{youtube}',
    }),
    videoRow(ids.vDraft, 'article', 'long', 'carried-draft', 'in_review'),
    videoRow(ids.vFailed, 'release', 'long', '1.3.0', 'approved', { destinations: '{instagram}' }),
    videoRow(ids.relVideo, 'release', 'long', '1.2.0', 'approved', { destinations: '{youtube}' }),
  ];
  const shares = [
    shareRow(ids.a, 'facebook', 'sent', 'blog', {
      external_id: '1234567890_9876543210',
      url: 'https://www.facebook.com/1234567890_9876543210',
    }),
    shareRow(ids.a, 'x', 'failed', 'blog'),
    shareRow(ids.rel, 'facebook', 'sent', 'social', {
      external_id: '1111111111_2222222222',
      url: 'https://www.facebook.com/1111111111_2222222222',
    }),
    shareRow(ids.long, 'youtube', 'sent', 'video', {
      external_id: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      detail: yt('dQw4w9WgXcQ'),
    }),
    shareRow(ids.long, 'facebook', 'sent', 'video', {
      external_id: '5555555555',
      url: 'https://www.facebook.com/reel/5555555555',
      detail: { dest: { token: SECRETS[5] } },
    }),
    shareRow(ids.long, 'x', 'pending', 'video'),
    shareRow(ids.short, 'youtube', 'sent', 'video', {
      external_id: 'abcDEF12345',
      url: 'https://www.youtube.com/shorts/abcDEF12345',
      detail: yt('abcDEF12345'),
    }),
    shareRow(ids.lib, 'youtube', 'sent', 'video', {
      external_id: 'libVID12345',
      url: 'https://www.youtube.com/watch?v=libVID12345',
      detail: yt('libVID12345'),
    }),
    shareRow(ids.vFailed, 'instagram', 'failed', 'video'),
    shareRow(ids.relVideo, 'youtube', 'sent', 'video', {
      external_id: 'relVID12345',
      url: 'https://youtu.be/relVID12345',
      detail: yt('relVID12345'),
    }),
  ];
  return [
    '--',
    '-- PostgreSQL database dump',
    '--',
    '-- Dumped from database version 18.6 (fixture)',
    'SET statement_timeout = 0;',
    '\\! touch /tmp/blogcarry-pwned-by-dump',
    'CREATE FUNCTION public.evil() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;',
    copy(
      'users',
      ['id', 'email', 'display_name', 'password_hash', 'kind'],
      [
        {
          id: ids.user,
          email: SECRETS[6],
          display_name: 'Owner',
          password_hash: SECRETS[0],
          kind: 'super_admin',
        },
      ],
    ),
    copy(
      'social_channels',
      ['network', 'account_id', 'access_token', 'refresh_token'],
      [{ network: 'facebook', account_id: '1', access_token: SECRETS[1], refresh_token: SECRETS[2] }],
    ),
    copy(
      'blog_api_keys',
      ['id', 'name', 'key_hash'],
      [{ id: ids.key, name: 'writer', key_hash: SECRETS[3] }],
    ),
    copy('blog_posts', BLOG_COLS, blog),
    copy('social_posts', SOCIAL_COLS, social),
    copy('social_shares', SHARE_COLS, shares),
    copy('video_posts', VIDEO_COLS, videos),
    '-- PostgreSQL database dump complete',
    '',
  ].join('\n');
}

const fakeYoutube = {
  accessToken: async () => 'access',
  channelMine: async () => ({ id: 'UC1', title: 'Guildwise HQ', verified: true }),
} as unknown as YouTubeClient;

let t: TestApp;
let sa: { id: string; email: string; cookie: string };
let dir: string;
const social = new FakeSocial();
/** Any destination post would land here (and fail): the import must leave nothing to post. */
const posted: string[] = [];
const destinations = new Proxy({} as VideoDestinationClient, {
  get: (_t, prop) => async (p: { network?: string }) => {
    posted.push(`${String(prop)}:${p?.network ?? ''}`);
    throw new Error('no network in tests');
  },
});
const api = (method: string, url: string, body?: unknown) =>
  t.req(method, url, { cookie: sa.cookie, ...(body !== undefined ? { body } : {}) });
const write = (name: string, body: string, gz = false) => {
  const p = join(dir, name);
  writeFileSync(p, gz ? gzipSync(body) : body);
  return p;
};
const makeBundle = async (name: string) => {
  const dump = write(`${name}.sql.gz`, fixtureDump(), true);
  const compare = write(`${name}-later.sql`, fixtureDump({ extraRow: true }));
  const out = join(dir, name);
  const r = await exportBundle({ dump, compare, out });
  return { out, r };
};
const count = async (sql: string) => Number((await q(sql))[0]?.n ?? 0);
const env = () => ({ pool: t.app.ctx.pool, store: t.app.ctx.store, clock: t.app.ctx.clock });

async function start() {
  t = await createTestApp({ env: { AOM_YOUTUBE_CLIENT_ID: 'cid', AOM_YOUTUBE_CLIENT_SECRET: 'csecret' } });
  t.app.ctx.youtube = fakeYoutube;
  t.app.ctx.social = social;
  t.app.ctx.videoDestinations = destinations;
  sa = await t.superAdminSession();
}
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'blog-bundle-'));
  await start();
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await t.close();
  await closeAdminPool();
});

describe('the COPY decoder', () => {
  it('decodes the escapes and NULL', () => {
    expect(decodeCopyField('\\N')).toBeNull();
    expect(decodeCopyField('a\\\\b\\tc\\nd\\re\\bf\\fg\\vh')).toBe('a\\b\tc\nd\re\bf\fg\vh');
    expect(decodeCopyField('\\101\\x42')).toBe('AB');
    expect(decodeCopyField('caf\\303\\251')).toBe('café');
    expect(decodeCopyField('plain é')).toBe('plain é');
  });

  it('reads only allow-listed COPY blocks and ignores everything else, including \\! lines', async () => {
    const f = write('decoder.sql', fixtureDump());
    const r = await readDumpTables(f, { blog_posts: ['id', 'slug', 'status'] });
    expect(Object.keys(r.tables)).toEqual(['blog_posts']);
    expect(r.tables.blog_posts?.map((x) => x.slug)).toContain('carried-agents');
    expect(r.pgVersion).toBe('18.6 (fixture)');
    expect(existsSync('/tmp/blogcarry-pwned-by-dump')).toBe(false);
    await expect(readDumpTables(f, { blog_posts: ['no_such_column'] })).rejects.toThrow(/no column/);
    const cut = write('truncated.sql', fixtureDump().split('\\.\n')[0] as string);
    await expect(readDumpTables(cut, { users: ['id'] })).rejects.toThrow(/never ends/);
  });
});

describe('export', () => {
  it('writes only published rows and sent shares, with checksums and no secret from the dump', async () => {
    const { out, r } = await makeBundle('export-ok');
    expect(r.manifest.counts).toEqual({ posts: 3, releases: 1, videos: 4, shares: 7 });
    expect(readdirSync(out).sort()).toEqual(
      [
        'REPORT.md',
        'SHA256SUMS',
        'manifest.json',
        'posts.json',
        'releases.json',
        'shares.json',
        'videos.json',
      ].sort(),
    );
    const all = readdirSync(out)
      .map((f) => readFileSync(join(out, f), 'utf8'))
      .join('\n');
    for (const s of SECRETS) expect(all).not.toContain(s);
    for (const s of ['sessionUri', 'rerender', '"dest"', 'steps', ids.user, ids.key])
      expect(all).not.toContain(s);
    const posts = JSON.parse(readFileSync(join(out, 'posts.json'), 'utf8'));
    expect(posts.map((p: any) => p.slug).sort()).toEqual([
      'carried-agents',
      'carried-manual',
      'what-is-an-ai-agent-team',
    ]);
    const a = posts.find((p: any) => p.slug === 'carried-agents');
    expect(a.content.title).toBe(contentA.title); // backslash and tab survive the COPY round trip
    expect(a.publishedAt).toBe(published.toISOString());
    expect(posts.find((p: any) => p.slug === 'carried-manual').authorName).toBe('Ada Writer');
    const videos = JSON.parse(readFileSync(join(out, 'videos.json'), 'utf8'));
    const long = videos.find((v: any) => v.id === ids.long);
    expect(long.destinations).toEqual(['youtube', 'facebook']); // the pending x is not a destination
    expect(videos.map((v: any) => v.id)).not.toContain(ids.vFailed);
    const shares = JSON.parse(readFileSync(join(out, 'shares.json'), 'utf8'));
    expect(shares.find((s: any) => s.postId === ids.long && s.network === 'youtube').detail).toEqual({
      videoId: 'dQw4w9WgXcQ',
      privacy: 'public',
      publishAt: published.toISOString(),
      verifiedAt: published.toISOString(),
      uploadedAt: created.toISOString(),
    });
    expect(shares.find((s: any) => s.postId === ids.long && s.network === 'facebook').detail).toEqual({});
    const report = readFileSync(join(out, 'REPORT.md'), 'utf8');
    expect(report).toContain('blog_posts late-in-review (in_review): only in the compared dump');
    expect(r.differences).toHaveLength(1);
    expect(loadBundle(out).id).toBe(r.bundleId);
  });

  it('refuses when a carried-over row differs in the compared dump, and when the output is not empty', async () => {
    const dump = write('diff.sql', fixtureDump());
    const compare = write('diff-later.sql', fixtureDump({ changeA: true }));
    await expect(exportBundle({ dump, compare, out: join(dir, 'diff') })).rejects.toThrow(
      /carried-agents \(published\) differs in the compared dump \(content, updated_at|content\)/,
    );
    expect(existsSync(join(dir, 'diff'))).toBe(false);
    const { out } = await makeBundle('nonempty');
    await expect(exportBundle({ dump, out })).rejects.toThrow(/not empty/);
  });

  it('refuses a body the renderer would have to neutralise', async () => {
    const tables = (
      await readDumpTables(write('x.sql', fixtureDump()), {
        blog_posts: [
          'id',
          'slug',
          'content',
          'status',
          'launch',
          'origin_kind',
          'author_name',
          'created_at',
          'updated_at',
          'published_at',
          'content_hash',
        ],
      })
    ).tables;
    const row = tables.blog_posts?.find((p) => p.slug === 'carried-agents') as Record<string, string>;
    const c = JSON.parse(row.content as string);
    c.bodyMarkdown += '\n\n<script>alert(1)</script>';
    row.content = JSON.stringify(c);
    row.content_hash = hash(c);
    expect(() => extract(tables)).toThrow(/raw HTML tag/);
  });
});

describe('the sanitiser', () => {
  const base = blogContent('sanitise-me');
  const blocks = (over: Partial<BlogContent>) =>
    checkPostContent('post x', { ...base, ...over })
      .filter((f) => f.level === 'block')
      .map((f) => f.message);

  it('passes a clean post and blocks each pattern', () => {
    expect(blocks({})).toEqual([]);
    const body = (s: string) => ({ bodyMarkdown: `${base.bodyMarkdown}\n\n${s}` });
    expect(blocks(body('<iframe src="https://evil.test"></iframe>'))).toContain('body: raw HTML tag');
    expect(blocks(body('text onload="x()" more'))).toContain('body: an on*= event handler attribute');
    expect(blocks(body('[x](javascript:alert(1))')).join()).toMatch(/javascript:/);
    expect(blocks(body('see data:text/html;base64,AAAA')).join()).toMatch(/data: URL/);
    expect(blocks(body('[x](ftp://files.test/a)')).join()).toMatch(/a link the renderer refuses/);
    expect(blocks(body('![alt](https://img.test/a.png)')).join()).toMatch(/image syntax/);
    expect(blocks({ title: `${base.title}\u202e` })).toContain('title: a control character or bidi override');
    expect(blocks({ summary: `${base.summary}\u0007` })).toContain(
      'summary: a control character or bidi override',
    );
    // the renderer strips cite tags itself: allowed
    expect(blocks(body('a <cite index="1-2">quoted</cite> passage'))).toEqual([]);
  });

  it('checks share ids and URLs per network', () => {
    const s = {
      postId: randomUUID(),
      source: 'video' as const,
      network: 'youtube' as const,
      externalId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      createdAt: published.toISOString(),
      updatedAt: published.toISOString(),
      detail: {},
    };
    expect(checkShare(s)).toEqual([]);
    expect(checkShare({ ...s, externalId: 'bad id"><script>' })).toHaveLength(1);
    expect(checkShare({ ...s, url: 'http://www.youtube.com/watch?v=x' })).toHaveLength(1);
    expect(checkShare({ ...s, url: 'https://evil.test/watch' })).toHaveLength(1);
  });

  it('every rendered bundle post is free of scripts, iframes, handlers and javascript: URLs', async () => {
    const { out } = await makeBundle('render-check');
    const { renderMarkdownHtml } = await import('@aom/shared');
    for (const p of loadBundle(out).posts) {
      const html = renderMarkdownHtml(p.content.bodyMarkdown);
      expect(html).not.toMatch(/<script|<iframe|\son\w+=|javascript:/i);
    }
  });
});

describe('loading a bundle', () => {
  it('refuses a tampered file, an extra file and a missing file', async () => {
    const { out } = await makeBundle('tamper');
    const posts = join(out, 'posts.json');
    const orig = readFileSync(posts, 'utf8');
    writeFileSync(posts, orig.replace('Carried over', 'Carried 0ver'));
    expect(() => loadBundle(out)).toThrow(/posts.json does not match its checksum/);
    writeFileSync(posts, orig);
    writeFileSync(join(out, 'evil.js'), 'x');
    expect(() => loadBundle(out)).toThrow(/not part of a version 1 bundle/);
    rmSync(join(out, 'evil.js'));
    expect(() => loadBundle(out)).not.toThrow();
    rmSync(join(out, 'REPORT.md'));
    expect(() => loadBundle(out)).toThrow(BundleRefused);
  });

  it('refuses an unknown key even with matching checksums', async () => {
    const { out } = await makeBundle('unknown-key');
    const p = join(out, 'shares.json');
    const shares = JSON.parse(readFileSync(p, 'utf8'));
    shares[0].token = 'x';
    const body = `${JSON.stringify(shares, null, 2)}\n`;
    writeFileSync(p, body);
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    const f = m.files.find((x: any) => x.path === 'shares.json');
    f.sha256 = sha(body);
    f.bytes = Buffer.byteLength(body);
    const mb = `${JSON.stringify(m, null, 2)}\n`;
    writeFileSync(join(out, 'manifest.json'), mb);
    const sums = readFileSync(join(out, 'SHA256SUMS'), 'utf8')
      .split('\n')
      .map((l) =>
        l.endsWith('  shares.json')
          ? `${sha(body)}  shares.json`
          : l.endsWith('  manifest.json')
            ? `${sha(mb)}  manifest.json`
            : l,
      )
      .join('\n');
    writeFileSync(join(out, 'SHA256SUMS'), sums);
    expect(() => loadBundle(out)).toThrow(/shares.json does not match the bundle format/);
  });
});

describe('import on an empty database', () => {
  // every test starts from an empty database (the event log is append-only: a fresh app truncates everything)
  beforeEach(async () => {
    await t.close();
    await start();
  });

  it('dry run writes nothing; apply keeps slugs, dates, byline and disclosure; a second apply writes nothing', async () => {
    const { out } = await makeBundle('import-ok');
    const b = loadBundle(out);
    const events0 = await count('SELECT count(*)::int AS n FROM events');
    const plan = await planImport(t.app.ctx.pool, b, sa.email);
    expect(plan.counts).toEqual({ create: 15, present: 0, 'launch-present': 0, conflict: 0 });
    expect(await count('SELECT count(*)::int AS n FROM events')).toBe(events0);
    expect(await count('SELECT count(*)::int AS n FROM blog_posts')).toBe(0);

    const r = await applyImport(env(), b, sa.email);
    expect(r).toMatchObject({ events: 8, shares: 7 });
    const rowsA = await q(`SELECT * FROM blog_posts WHERE slug='carried-agents'`);
    expect(rowsA[0]).toMatchObject({
      status: 'published',
      launch: true,
      origin_user_id: sa.id,
      origin_kind: 'writer',
    });
    expect(new Date(rowsA[0]?.published_at).toISOString()).toBe(published.toISOString());
    expect(new Date(rowsA[0]?.created_at).toISOString()).toBe(created.toISOString());
    const page = await t.app.inject({ method: 'GET', url: '/blog/carried-agents' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`datetime="${published.toISOString().slice(0, 10)}`);
    expect(page.body).toContain('The Guildwise HQ team');
    expect(page.body).toContain('written by an AI agent');
    const manual = await t.app.inject({ method: 'GET', url: '/blog/carried-manual' });
    expect(manual.statusCode).toBe(200);
    expect(manual.body).toContain('Ada Writer');
    const rss = await t.app.inject({ method: 'GET', url: '/blog/rss.xml' });
    expect(rss.body).toContain(published.toUTCString());
    const map = await t.app.inject({ method: 'GET', url: '/sitemap.xml' });
    expect(map.body).toContain('<loc>http://aom.test/blog/carried-agents</loc>');
    expect(map.body).toContain(published.toISOString().slice(0, 10));
    expect((await q(`SELECT status FROM social_posts WHERE id=$1`, [ids.rel]))[0]?.status).toBe('approved');
    expect(await count(`SELECT count(*)::int AS n FROM social_shares WHERE status='sent'`)).toBe(7);
    expect(
      await count(`SELECT count(*)::int AS n FROM platform_audit_log WHERE action LIKE '%Imported'`),
    ).toBe(8);
    expect(
      await count(`SELECT count(*)::int AS n FROM data_migrations WHERE name LIKE 'blog-carryover:%'`),
    ).toBe(1);
    // the imported articles do not start the auto-publish period
    expect((await blogSettings(t.app.ctx)).reviewAll).toBe(true);

    const events1 = await count('SELECT count(*)::int AS n FROM events');
    const again = await applyImport(env(), b, sa.email);
    expect(again).toMatchObject({ events: 0, shares: 0 });
    expect(again.plan.counts).toEqual({ create: 0, present: 15, 'launch-present': 0, conflict: 0 });
    expect(await count('SELECT count(*)::int AS n FROM events')).toBe(events1);

    // a projection rebuild reproduces the rows from the events
    const snap = async () =>
      q(`SELECT id, slug, status, launch, published_at, created_at, updated_at FROM blog_posts ORDER BY id`);
    const before = await snap();
    const vids = await q('SELECT id, status, destinations, approved_at FROM video_posts ORDER BY id');
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    expect(await snap()).toEqual(before);
    expect(await q('SELECT id, status, destinations, approved_at FROM video_posts ORDER BY id')).toEqual(
      vids,
    );
    expect(await count(`SELECT count(*)::int AS n FROM social_shares WHERE status='sent'`)).toBe(7);
  });

  it("skips this install's launch posts, refuses a slug conflict and a non-super-admin, and writes nothing then", async () => {
    const { out } = await makeBundle('import-conflict');
    const b = loadBundle(out);
    await migrateBlogLaunch({
      pool: t.app.ctx.pool,
      store: t.app.ctx.store,
      clock: t.app.ctx.clock,
      log: () => {},
    } as never);
    const plan = await planImport(t.app.ctx.pool, b, sa.email);
    expect(plan.items.find((i) => i.label === 'post what-is-an-ai-agent-team')?.action).toBe(
      'launch-present',
    );
    expect(plan.conflicts).toBe(0);

    const member = `member-${randomUUID().slice(0, 6)}@x.test`;
    await t.createUser(member);
    expect((await q('SELECT kind FROM users WHERE email=$1', [member]))[0]?.kind).not.toBe('super_admin');
    await expect(planImport(t.app.ctx.pool, b, member)).rejects.toThrow(/not an active super admin/);

    // someone wrote an article with the same slug on the new install
    await q(
      `INSERT INTO blog_posts (id, slug, content, title, summary, tags, status, content_hash, warnings, word_count, reading_minutes, created_at, updated_at, origin_kind)
       VALUES ($1,'carried-agents','{}','t','s','{}','draft','h','[]',1,1,now(),now(),'manual')`,
      [randomUUID()],
    );
    const events0 = await count('SELECT count(*)::int AS n FROM events');
    const r = await applyImport(env(), b, sa.email);
    expect(r.events).toBe(0);
    expect(r.plan.items.find((i) => i.label === 'post carried-agents')?.action).toBe('conflict');
    expect(await count('SELECT count(*)::int AS n FROM events')).toBe(events0);
    expect(await count(`SELECT count(*)::int AS n FROM social_shares`)).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM video_posts`)).toBe(0);
  });

  it('an imported release post is never shared again, not even to a network it was not sent to', async () => {
    for (const n of ['facebook', 'linkedin', 'x', 'bluesky'])
      await q(
        `INSERT INTO social_channels (network, account_id, account_name, access_token, status, connected_by, connected_at)
         VALUES ($1,'acc-1',$1,$2,'ok',$3,$4)`,
        [
          n,
          await encryptSecret(t.app.ctx, `${n}-token-0123456789`),
          sa.id,
          new Date(published.getTime() - HOUR),
        ],
      );
    const { out } = await makeBundle('import-release');
    await applyImport(env(), loadBundle(out), sa.email);
    expect((await q(`SELECT origin_system FROM social_posts WHERE id=$1`, [ids.rel]))[0]?.origin_system).toBe(
      'carried-over',
    );
    for (let i = 0; i < 3; i++) await socialTick(t.app.ctx);
    expect(
      await q(`SELECT network, status, external_id FROM social_shares WHERE post_id=$1`, [ids.rel]),
    ).toEqual([{ network: 'facebook', status: 'sent', external_id: '1111111111_2222222222' }]);
    expect(social.calls).toHaveLength(0);
    // the guard survives a projection rebuild
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    await socialTick(t.app.ctx);
    expect(await count(`SELECT count(*)::int AS n FROM social_shares WHERE post_id='${ids.rel}'`)).toBe(1);
  });

  it('AC7: an imported published video is not queued again, and nothing is shared or drafted again', async () => {
    // channels and videos are on before the import (the worst case): every network the fixture used is connected
    await ok(
      api('PATCH', '/api/platform/video/settings', {
        enabled: true,
        articleVideos: true,
        releaseVideos: true,
        tutorials: true,
      }),
    );
    await ok(
      api('PUT', '/api/platform/social/channels/youtube', { refreshToken: '1//0g-refresh-token-value' }),
    );
    // the other channels as rows (connecting through the API would ask the networks; nothing here may reach one)
    for (const n of ['facebook', 'linkedin', 'x', 'bluesky', 'instagram', 'tiktok'])
      await q(
        `INSERT INTO social_channels (network, account_id, account_name, access_token, status, connected_by, connected_at)
         VALUES ($1,'acc-1',$1,$2,'ok',$3,now())`,
        [n, await encryptSecret(t.app.ctx, `${n}-token-0123456789`), sa.id],
      );
    // connected before the posts' publish time: without `launch` the share sweep would take the fresh article
    await q(`UPDATE social_channels SET connected_at = $1`, [new Date(published.getTime() - HOUR)]);

    const { out } = await makeBundle('import-ac7');
    const b = loadBundle(out);
    await applyImport(env(), b, sa.email);
    const sharesBefore = await q(
      'SELECT post_id, network, status, external_id FROM social_shares ORDER BY post_id, network',
    );
    expect(sharesBefore).toHaveLength(7);

    for (let i = 0; i < 3; i++) {
      await videoTick(t.app.ctx, { role: 'publish' });
      await socialTick(t.app.ctx);
    }
    expect(
      await q('SELECT post_id, network, status, external_id FROM social_shares ORDER BY post_id, network'),
    ).toEqual(sharesBefore);
    expect(social.calls).toHaveLength(0);
    expect(posted).toEqual([]);
    // no render for an imported post, except the library video's own file (healRenders): its upload stays a no-op
    expect(await count('SELECT count(*)::int AS n FROM video_renders WHERE NOT library')).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM social_shares WHERE status <> 'sent'`)).toBe(0);
    const phase = await ok(api('GET', `/api/platform/video/posts/${ids.long}`));
    expect(phase.phase ?? phase.post?.phase).toBe('published');

    expect((await articlesNeedingVideo(t.app.ctx, 30)).map((a) => a.slug)).not.toContain('carried-agents');
    expect((await releasesNeedingVideo(t.app.ctx, 3650)).map((r) => r.version)).not.toContain('1.2.0');
    const lib = await importLibrary(t.app.ctx, { userId: sa.id }, ['overview']).catch((e: Error) => e);
    if (!(lib instanceof Error)) expect(lib.created).toHaveLength(0);
    expect(await count(`SELECT count(*)::int AS n FROM video_posts WHERE ref='lib:overview'`)).toBe(1);
    expect(await publicVideoEmbed(t.app.ctx, 'article', 'carried-agents')).toEqual({
      videoId: 'dQw4w9WgXcQ',
      title: 'Video carried-agents long',
    });
  });
});
