import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  BLOG_BUNDLE_FORMAT,
  BLOG_BUNDLE_VERSION,
  type BundleManifest,
  BundleManifestSchema,
  type BundlePost,
  BundlePostSchema,
  type BundleRelease,
  BundleReleaseSchema,
  type BundleShare,
  type BundleShareDetail,
  BundleShareSchema,
  type BundleVideo,
  BundleVideoSchema,
  VIDEO_DESTINATIONS,
} from '@aom/shared';
import { type DumpRow, readDumpTables } from './pgdump.ts';
import { blocking, checkPost, checkRelease, checkShare, checkVideo, type Finding } from './sanitize.ts';

/**
 * `blog-bundle-export`: the published articles, the approved release announcements and the video publishing log of an
 * old install, read from its plain `pg_dump` file as data (never restored, never run), into a reviewable bundle
 * (docs/SELF-HOSTING.md "Carry blog articles to a new install"). Only the columns below are read; nothing else leaves the dump.
 */

/** The only tables and columns the export reads. */
export const DUMP_COLUMNS = {
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
  social_posts: ['id', 'kind', 'ref', 'content', 'status', 'created_at', 'approved_at'],
  video_posts: ['id', 'kind', 'format', 'ref', 'parent_id', 'meta', 'status', 'created_at', 'approved_at'],
  social_shares: [
    'post_id',
    'network',
    'status',
    'source',
    'external_id',
    'url',
    'created_at',
    'updated_at',
    'detail',
  ],
} as const;

export class ExportRefused extends Error {
  constructor(
    message: string,
    readonly findings: string[] = [],
  ) {
    super(findings.length ? `${message}:\n- ${findings.join('\n- ')}` : message);
    this.name = 'ExportRefused';
  }
}

/** `2026-11-03 06:00:45.123456+00` (COPY text of a timestamptz) -> ISO 8601 UTC (milliseconds). */
export function pgTimestamp(v: string | null | undefined, what: string): string {
  const m =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,6})?([+-]\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/.exec(
      v ?? '',
    );
  if (!m) throw new ExportRefused(`${what}: not a timestamp (${String(v).slice(0, 40)})`);
  const frac = (m[3] ?? '.000').slice(0, 4).padEnd(4, '0');
  const d = new Date(`${m[1]}T${m[2]}${frac}${m[4]}:${m[5] ?? '00'}`);
  if (Number.isNaN(d.getTime())) throw new ExportRefused(`${what}: not a timestamp`);
  return d.toISOString();
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

const json = (v: string | null | undefined, what: string): unknown => {
  try {
    return JSON.parse(v ?? 'null');
  } catch {
    throw new ExportRefused(`${what}: not JSON`);
  }
};
const zodMsg = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }): string =>
  e.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');

/** The allow-listed `detail` of a share: the YouTube facts only (never `dest`, `sessionUri`, `rerender`, `steps`, ...). */
export function shareDetail(network: string, raw: unknown): BundleShareDetail {
  if (network !== 'youtube' || !raw || typeof raw !== 'object') return {};
  const d = raw as Record<string, unknown>;
  const out: BundleShareDetail = {};
  if (typeof d.videoId === 'string') out.videoId = d.videoId;
  if (d.privacy === 'public' || d.privacy === 'unlisted' || d.privacy === 'private') out.privacy = d.privacy;
  if (typeof d.publishAt === 'string' || d.publishAt === null)
    out.publishAt = typeof d.publishAt === 'string' ? new Date(d.publishAt).toISOString() : null;
  if (typeof d.verifiedAt === 'string') out.verifiedAt = new Date(d.verifiedAt).toISOString();
  if (typeof d.uploadedAt === 'string') out.uploadedAt = new Date(d.uploadedAt).toISOString();
  return out;
}

export interface Extracted {
  posts: BundlePost[];
  releases: BundleRelease[];
  videos: BundleVideo[];
  shares: BundleShare[];
  findings: Finding[];
  /** Rows left out on purpose, with the reason (for the report). */
  excluded: string[];
}

/** Turns the raw dump rows into bundle items. Throws `ExportRefused` on a row the app's schemas refuse. */
export function extract(tables: Record<string, DumpRow[]>): Extracted {
  const findings: Finding[] = [];
  const excluded: string[] = [];
  const bad: string[] = [];

  const blogRows = tables.blog_posts ?? [];
  const posts: BundlePost[] = [];
  for (const r of blogRows.filter((x) => x.status === 'published')) {
    const what = `post ${r.slug}`;
    const content = json(r.content, what) as Record<string, unknown>;
    const candidate = {
      id: r.id,
      slug: r.slug,
      content,
      launch: r.launch === 't',
      originKind: r.origin_kind,
      authorName: r.origin_kind === 'manual' ? r.author_name : null,
      createdAt: pgTimestamp(r.created_at, what),
      updatedAt: pgTimestamp(r.updated_at, what),
      publishedAt: pgTimestamp(r.published_at, what),
      contentHash: r.content_hash,
    };
    let parsed = BundlePostSchema.safeParse(candidate);
    if (!parsed.success) {
      // the social captions are only used for sharing, which is done: a post that fails on them alone keeps going without them
      const { social: _social, ...rest } = content;
      const retry = BundlePostSchema.safeParse({ ...candidate, content: rest });
      if (retry.success) {
        findings.push({
          item: what,
          level: 'record',
          message: 'content.social failed the schema and was dropped',
        });
        parsed = retry;
      }
    }
    if (!parsed.success) {
      bad.push(`${what}: ${zodMsg(parsed.error)}`);
      continue;
    }
    if (parsed.data.content.slug !== parsed.data.slug)
      bad.push(`${what}: content.slug differs from the slug`);
    const hash = sha256(`${parsed.data.content.title}\n${parsed.data.content.bodyMarkdown}`);
    if (hash !== parsed.data.contentHash) bad.push(`${what}: content_hash is not sha256(title\\nbody)`);
    posts.push(parsed.data);
  }
  const unpublished = blogRows.filter((x) => x.status !== 'published');
  excluded.push(
    `${unpublished.length} blog post(s) not published${unpublished.length ? ` (${[...new Set(unpublished.map((x) => x.status))].join(', ')})` : ''}`,
  );

  const socialRows = tables.social_posts ?? [];
  const releases: BundleRelease[] = [];
  for (const r of socialRows.filter((x) => x.kind === 'release' && x.status === 'approved')) {
    const what = `release ${r.ref}`;
    const parsed = BundleReleaseSchema.safeParse({
      id: r.id,
      ref: r.ref,
      content: json(r.content, what),
      createdAt: pgTimestamp(r.created_at, what),
      approvedAt: pgTimestamp(r.approved_at, what),
    });
    if (!parsed.success) bad.push(`${what}: ${zodMsg(parsed.error)}`);
    else releases.push(parsed.data);
  }
  const otherSocial = socialRows.filter((x) => !(x.kind === 'release' && x.status === 'approved'));
  excluded.push(
    `${otherSocial.length} social post(s) not approved releases (${[
      ...new Set(otherSocial.map((x) => `${x.kind} ${x.status}`)),
    ].join(', ')})`,
  );

  const shareRows = tables.social_shares ?? [];
  const sent = shareRows.filter((s) => s.status === 'sent');
  const postIds = new Set(posts.map((p) => p.id));
  const releaseIds = new Set(releases.map((p) => p.id));

  const videoRows = tables.video_posts ?? [];
  const videos: BundleVideo[] = [];
  for (const r of videoRows.filter((x) => x.status === 'approved')) {
    const what = `video ${r.kind}/${r.ref}/${r.format}`;
    const nets = [
      ...new Set(
        sent.filter((s) => s.source === 'video' && s.post_id === r.id).map((s) => s.network as string),
      ),
    ];
    if (!nets.length) continue; // approved but never sent anywhere: not published
    const destinations = VIDEO_DESTINATIONS.filter((d) => nets.includes(d));
    if (destinations.length !== nets.length)
      bad.push(`${what}: a sent network that is not a video destination`);
    const parsed = BundleVideoSchema.safeParse({
      id: r.id,
      kind: r.kind,
      format: r.format,
      ref: r.ref,
      parentId: r.parent_id,
      meta: json(r.meta, what),
      destinations,
      createdAt: pgTimestamp(r.created_at, what),
      approvedAt: pgTimestamp(r.approved_at, what),
    });
    if (!parsed.success) bad.push(`${what}: ${zodMsg(parsed.error)}`);
    else videos.push(parsed.data);
  }
  excluded.push(
    `${videoRows.length - videos.length} video post(s) never sent to any network (drafts, review, rejected, unsent)`,
  );
  const videoIds = new Set(videos.map((v) => v.id));
  for (const v of videos)
    if (v.parentId && !videoIds.has(v.parentId))
      findings.push({
        item: `video ${v.kind}/${v.ref}/${v.format}`,
        level: 'record',
        message: 'its long video is not in the bundle (the import needs it to exist already)',
      });

  const shares: BundleShare[] = [];
  for (const s of sent) {
    const of =
      s.source === 'blog'
        ? postIds
        : s.source === 'social'
          ? releaseIds
          : s.source === 'video'
            ? videoIds
            : null;
    if (!of?.has(s.post_id as string)) continue;
    const what = `share ${s.post_id}/${s.network}`;
    const parsed = BundleShareSchema.safeParse({
      postId: s.post_id,
      source: s.source,
      network: s.network,
      externalId: s.external_id,
      url: s.url,
      createdAt: pgTimestamp(s.created_at, what),
      updatedAt: pgTimestamp(s.updated_at, what),
      detail: shareDetail(s.network as string, json(s.detail, what)),
    });
    if (!parsed.success) bad.push(`${what}: ${zodMsg(parsed.error)}`);
    else shares.push(parsed.data);
  }
  const unsent = shareRows.filter((s) => s.status !== 'sent');
  excluded.push(
    `${unsent.length} share row(s) not sent (${Object.entries(
      unsent.reduce<Record<string, number>>((a, s) => {
        const k = `${s.source}/${s.network} ${s.status}`;
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {}),
    )
      .map(([k, n]) => `${k} x${n}`)
      .join(', ')})`,
  );
  const orphan = sent.length - shares.length;
  if (orphan) excluded.push(`${orphan} sent share row(s) of posts that are not carried over`);

  if (bad.length) throw new ExportRefused('rows the app schemas refuse', bad);
  for (const p of posts) findings.push(...checkPost(p));
  for (const r of releases) findings.push(...checkRelease(r));
  for (const v of videos) findings.push(...checkVideo(v));
  for (const s of shares) findings.push(...checkShare(s));
  const blocks = blocking(findings);
  if (blocks.length)
    throw new ExportRefused(
      'content the renderer would have to neutralise',
      blocks.map((b) => `${b.item}: ${b.message}`),
    );
  const byDate = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  return {
    posts: posts.sort(byDate),
    releases: releases.sort(byDate),
    videos: videos.sort(byDate),
    shares: shares.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) ||
        `${a.postId}${a.network}`.localeCompare(`${b.postId}${b.network}`),
    ),
    findings,
    excluded,
  };
}

const rowKey = (t: string, r: DumpRow): string =>
  t === 'social_shares' ? `${r.post_id}/${r.network}` : (r.id as string);
const rowLabel = (t: string, r: DumpRow): string =>
  t === 'blog_posts'
    ? `blog_posts ${r.slug} (${r.status})`
    : t === 'social_posts'
      ? `social_posts ${r.kind} ${r.ref} (${r.status})`
      : t === 'video_posts'
        ? `video_posts ${r.kind}/${r.ref}/${r.format} (${r.status})`
        : `social_shares ${r.source}/${r.network} of ${r.post_id} (${r.status})`;

/**
 * Compares the read tables of two dumps. Every difference is listed; a difference in a row that is carried over refuses
 * the export (the source must agree with the later copy for everything that is imported).
 */
export function compareDumps(
  a: Record<string, DumpRow[]>,
  b: Record<string, DumpRow[]>,
  exported: Set<string>,
): { differences: string[]; refused: string[] } {
  const differences: string[] = [];
  const refused: string[] = [];
  for (const t of Object.keys(DUMP_COLUMNS)) {
    const am = new Map((a[t] ?? []).map((r) => [rowKey(t, r), r]));
    const bm = new Map((b[t] ?? []).map((r) => [rowKey(t, r), r]));
    for (const [k, r] of am) {
      const other = bm.get(k);
      const hit = exported.has(`${t}:${k}`);
      if (!other) {
        differences.push(`${rowLabel(t, r)}: only in the source`);
        if (hit) refused.push(`${rowLabel(t, r)} is missing from the compared dump`);
      } else if (JSON.stringify(r) !== JSON.stringify(other)) {
        const cols = Object.keys(r).filter((c) => r[c] !== other[c]);
        differences.push(`${rowLabel(t, r)}: differs in ${cols.join(', ')}`);
        if (hit) refused.push(`${rowLabel(t, r)} differs in the compared dump (${cols.join(', ')})`);
      }
    }
    for (const [k, r] of bm) if (!am.has(k)) differences.push(`${rowLabel(t, r)}: only in the compared dump`);
  }
  return { differences, refused };
}

export interface ExportOptions {
  dump: string;
  compare?: string | undefined;
  out: string;
  now?: Date;
}

export interface ExportResult {
  manifest: BundleManifest;
  bundleId: string;
  findings: Finding[];
  differences: string[];
}

function report(x: Extracted, m: BundleManifest, differences: string[]): string {
  const rec = x.findings.filter((f) => f.level === 'record');
  const nets = (src: string) =>
    Object.entries(
      x.shares
        .filter((s) => s.source === src)
        .reduce<Record<string, number>>((a, s) => {
          a[s.network] = (a[s.network] ?? 0) + 1;
          return a;
        }, {}),
    )
      .map(([n, c]) => `${n} ${c}`)
      .join(', ') || 'none';
  return [
    '# Blog carry-over bundle',
    '',
    `Source: \`${m.source.file}\` (sha256 \`${m.source.sha256}\`, PostgreSQL ${m.source.pgVersion ?? 'unknown'}).`,
    m.compared
      ? `Compared with: \`${m.compared.file}\` (sha256 \`${m.compared.sha256}\`).`
      : 'Compared with: nothing (no --compare).',
    `Created: ${m.createdAt}. The dump was parsed as text (COPY blocks of the four tables below); none of it was executed.`,
    '',
    '## Counts',
    '',
    `- Published articles: ${m.counts.posts} (${x.posts.filter((p) => p.launch).length} of them launch-set articles)`,
    `- Approved release announcements: ${m.counts.releases} (${x.releases.map((r) => r.ref).join(', ') || 'none'})`,
    `- Published videos: ${m.counts.videos} (${x.videos.filter((v) => v.format === 'long').length} long, ${x.videos.filter((v) => v.format === 'short').length} Shorts)`,
    `- Sent shares: ${m.counts.shares}`,
    `  - articles: ${nets('blog')}`,
    `  - releases: ${nets('social')}`,
    `  - videos: ${nets('video')}`,
    '',
    '## Differences with the compared dump',
    '',
    ...(m.compared
      ? differences.length
        ? differences.map((d) => `- ${d}`)
        : ['- none']
      : ['- not compared']),
    '',
    'A difference in a carried-over row refuses the export, so every difference above is in a row that is not carried over.',
    '',
    '## Content checks',
    '',
    'Blocking findings: 0 (the export refuses when there is one: raw HTML, an on*= handler, a javascript:/vbscript:/data: URL,',
    'a link the renderer refuses, image syntax or blog media, a control character or bidi override, an invalid share id or URL).',
    '',
    `Recorded findings: ${rec.length}`,
    ...rec.map((f) => `- ${f.item}: ${f.message}`),
    '',
    '## Left out, on purpose',
    '',
    ...x.excluded.map((e) => `- ${e}`),
    '- Never read: users, sessions, API keys, blog_api_keys, social_channels (tokens), video scripts, renders, errors, attempts.',
    '- Share `detail` keeps only YouTube videoId, privacy, publishAt, verifiedAt and uploadedAt.',
    '- No media: covers are static per tag and ship with the code; no article references /blog/media/.',
    '',
  ].join('\n');
}

/** Reads the dump(s), checks everything, and writes the bundle into `out` (which must not exist or be empty). */
export async function exportBundle(o: ExportOptions): Promise<ExportResult> {
  if (existsSync(o.out) && readdirSync(o.out).length) throw new ExportRefused(`${o.out} is not empty`);
  const src = await readDumpTables(o.dump, DUMP_COLUMNS);
  const x = extract(src.tables);
  let compared: BundleManifest['compared'] = null;
  let differences: string[] = [];
  if (o.compare) {
    const other = await readDumpTables(o.compare, DUMP_COLUMNS);
    const exported = new Set<string>([
      ...x.posts.map((p) => `blog_posts:${p.id}`),
      ...x.releases.map((p) => `social_posts:${p.id}`),
      ...x.videos.map((p) => `video_posts:${p.id}`),
      ...x.shares.map((s) => `social_shares:${s.postId}/${s.network}`),
    ]);
    const c = compareDumps(src.tables, other.tables, exported);
    if (c.refused.length)
      throw new ExportRefused('carried-over rows differ from the compared dump', c.refused);
    differences = c.differences;
    compared = { file: basename(o.compare), sha256: await sha256File(o.compare), differences };
  }
  const files: Record<string, string> = {
    'posts.json': `${JSON.stringify(x.posts, null, 2)}\n`,
    'releases.json': `${JSON.stringify(x.releases, null, 2)}\n`,
    'videos.json': `${JSON.stringify(x.videos, null, 2)}\n`,
    'shares.json': `${JSON.stringify(x.shares, null, 2)}\n`,
  };
  const base = {
    format: BLOG_BUNDLE_FORMAT,
    version: BLOG_BUNDLE_VERSION,
    createdAt: (o.now ?? new Date()).toISOString(),
    source: { file: basename(o.dump), sha256: await sha256File(o.dump), pgVersion: src.pgVersion },
    compared,
    counts: {
      posts: x.posts.length,
      releases: x.releases.length,
      videos: x.videos.length,
      shares: x.shares.length,
    },
  } as const;
  files['REPORT.md'] = report(x, { ...base, files: [] }, differences);
  const manifest = BundleManifestSchema.parse({
    ...base,
    files: Object.entries(files).map(([path, body]) => ({
      path,
      bytes: Buffer.byteLength(body),
      sha256: sha256(body),
    })),
  });
  files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  mkdirSync(o.out, { recursive: true, mode: 0o700 });
  const names = Object.keys(files).sort();
  for (const n of names) writeFileSync(join(o.out, n), files[n] as string, { mode: 0o600 });
  writeFileSync(
    join(o.out, 'SHA256SUMS'),
    names.map((n) => `${sha256(files[n] as string)}  ${n}\n`).join(''),
    { mode: 0o600 },
  );
  return { manifest, bundleId: sha256(files['manifest.json'] as string), findings: x.findings, differences };
}
