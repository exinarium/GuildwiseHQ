import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BLOG_BUNDLE_FILES,
  BLOG_BUNDLE_MAX_BYTES,
  type BundleManifest,
  BundleManifestSchema,
  type BundlePost,
  BundlePostsSchema,
  type BundleRelease,
  BundleReleasesSchema,
  type BundleShare,
  BundleSharesSchema,
  type BundleVideo,
  BundleVideosSchema,
} from '@aom/shared';
import type pg from 'pg';
import type { z } from 'zod';
import type { Clock } from '../../clock.ts';
import { blogStream } from '../../commands/blog.ts';
import { userActor } from '../../commands/common.ts';
import { socialPostStream } from '../../commands/social-posts.ts';
import { videoPostStream } from '../../commands/video-posts.ts';
import { BLOG_LAUNCH_MIGRATION } from '../../data-migrations/blog-launch.ts';
import { one, rows } from '../../db/sql.ts';
import { type Tx, withAppendTx, withTx } from '../../db/tx.ts';
import type { AppendInput, EventStore } from '../../eventstore/types.ts';
import { blocking, checkPost, checkRelease, checkShare, checkVideo } from './sanitize.ts';

/**
 * `blog-bundle-import`: loads a reviewed carry-over bundle into this install (docs/SELF-HOSTING.md). A dry run unless
 * `apply`; one transaction under the append lock; any conflict writes nothing; a second run finds every item `present` and
 * writes nothing. Articles, release posts and videos are appended as `*Imported` events that carry the original dates; the
 * sent shares are inserted into `social_shares` (operational) so the publisher sees them as done and never posts them again.
 */

export class BundleRefused extends Error {
  constructor(
    message: string,
    readonly reasons: string[] = [],
  ) {
    super(reasons.length ? `${message}:\n- ${reasons.join('\n- ')}` : message);
    this.name = 'BundleRefused';
  }
}

export interface Bundle {
  id: string;
  manifest: BundleManifest;
  posts: BundlePost[];
  releases: BundleRelease[];
  videos: BundleVideo[];
  shares: BundleShare[];
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Reads and checks a bundle directory: checksums, the file list, the size cap, the strict schemas and the content rules. */
export function loadBundle(dir: string): Bundle {
  const allowed = new Set<string>([...BLOG_BUNDLE_FILES, 'SHA256SUMS']);
  const entries = readdirSync(dir);
  const extra = entries.filter((e) => !allowed.has(e));
  if (extra.length) throw new BundleRefused('files that are not part of a version 1 bundle', extra);
  let total = 0;
  const data = new Map<string, Buffer>();
  for (const name of allowed) {
    const p = join(dir, name);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      throw new BundleRefused(`${name} is missing`);
    }
    if (!st.isFile()) throw new BundleRefused(`${name} is not a regular file`);
    total += st.size;
    if (total > BLOG_BUNDLE_MAX_BYTES)
      throw new BundleRefused(`the bundle is larger than ${BLOG_BUNDLE_MAX_BYTES} bytes`);
    data.set(name, readFileSync(p));
  }
  const sums = new Map<string, string>();
  for (const line of (data.get('SHA256SUMS') as Buffer).toString('utf8').split('\n')) {
    if (!line) continue;
    const m = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$/.exec(line);
    if (!m) throw new BundleRefused('SHA256SUMS has a line that is not "<sha256>  <file>"');
    sums.set(m[2] as string, m[1] as string);
  }
  const bad: string[] = [];
  for (const name of BLOG_BUNDLE_FILES) {
    const want = sums.get(name);
    if (!want) bad.push(`${name} is not listed in SHA256SUMS`);
    else if (want !== sha256(data.get(name) as Buffer)) bad.push(`${name} does not match its checksum`);
  }
  for (const name of sums.keys())
    if (!(BLOG_BUNDLE_FILES as readonly string[]).includes(name)) bad.push(`SHA256SUMS lists ${name}`);
  if (bad.length) throw new BundleRefused('checksums', bad);

  const parse = <S extends z.ZodType>(name: string, schema: S): z.infer<S> => {
    let raw: unknown;
    try {
      raw = JSON.parse((data.get(name) as Buffer).toString('utf8'));
    } catch {
      throw new BundleRefused(`${name} is not JSON`);
    }
    const r = schema.safeParse(raw);
    if (!r.success)
      throw new BundleRefused(
        `${name} does not match the bundle format`,
        r.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join('.')}: ${i.message}`),
      );
    return r.data;
  };
  const manifest = parse('manifest.json', BundleManifestSchema);
  for (const f of manifest.files) {
    const b = data.get(f.path) as Buffer;
    if (b.length !== f.bytes || sha256(b) !== f.sha256) bad.push(`${f.path} differs from the manifest`);
  }
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const n of BLOG_BUNDLE_FILES)
    if (n !== 'manifest.json' && !listed.has(n)) bad.push(`the manifest does not list ${n}`);
  if (bad.length) throw new BundleRefused('manifest', bad);

  const posts = parse('posts.json', BundlePostsSchema);
  const releases = parse('releases.json', BundleReleasesSchema);
  const videos = parse('videos.json', BundleVideosSchema);
  const shares = parse('shares.json', BundleSharesSchema);
  const c = manifest.counts;
  if (
    c.posts !== posts.length ||
    c.releases !== releases.length ||
    c.videos !== videos.length ||
    c.shares !== shares.length
  )
    throw new BundleRefused('the manifest counts do not match the files');

  // the same content rules as the export, again
  const findings = blocking([
    ...posts.flatMap(checkPost),
    ...releases.flatMap(checkRelease),
    ...videos.flatMap(checkVideo),
    ...shares.flatMap(checkShare),
  ]);
  if (findings.length)
    throw new BundleRefused(
      'content the renderer would have to neutralise',
      findings.map((f) => `${f.item}: ${f.message}`),
    );

  // internal consistency: unique ids, every share belongs to an item of its kind, a video's destinations are its sent shares
  const ids = [...posts, ...releases, ...videos].map((x) => x.id);
  if (new Set(ids).size !== ids.length) bad.push('an id appears twice');
  const slugs = posts.map((p) => p.slug);
  if (new Set(slugs).size !== slugs.length) bad.push('a slug appears twice');
  for (const p of posts) {
    if (p.content.slug !== p.slug) bad.push(`post ${p.slug}: content.slug differs`);
    if (sha256(`${p.content.title}\n${p.content.bodyMarkdown}`) !== p.contentHash)
      bad.push(`post ${p.slug}: contentHash is not sha256(title\\nbody)`);
  }
  const of = {
    blog: new Set(posts.map((p) => p.id)),
    social: new Set(releases.map((r) => r.id)),
    video: new Set(videos.map((v) => v.id)),
  };
  const shareKeys = new Set<string>();
  for (const s of shares) {
    if (!of[s.source].has(s.postId))
      bad.push(`share ${s.postId}/${s.network}: its ${s.source} item is not in the bundle`);
    const k = `${s.postId}/${s.network}`;
    if (shareKeys.has(k)) bad.push(`share ${k} appears twice`);
    shareKeys.add(k);
  }
  for (const v of videos) {
    const sent = shares
      .filter((s) => s.source === 'video' && s.postId === v.id)
      .map((s) => s.network as string);
    if (sent.length !== v.destinations.length || v.destinations.some((d) => !sent.includes(d)))
      bad.push(`video ${v.kind}/${v.ref}/${v.format}: destinations are not exactly its sent networks`);
  }
  if (bad.length) throw new BundleRefused('the bundle is not consistent', bad);
  return { id: sha256(data.get('manifest.json') as Buffer), manifest, posts, releases, videos, shares };
}

export type ItemAction = 'create' | 'present' | 'launch-present' | 'conflict';
export interface PlanItem {
  kind: 'post' | 'release' | 'video' | 'share';
  label: string;
  action: ItemAction;
  reason?: string;
}
export interface ImportPlan {
  bundleId: string;
  author: { id: string; email: string };
  items: PlanItem[];
  counts: Record<ItemAction, number>;
  conflicts: number;
}

/** The marker of a completed import (operational, `data_migrations`). */
export const importMarker = (bundleId: string) => `blog-carryover:${bundleId}`;

async function author(db: Tx, email: string): Promise<{ id: string; email: string }> {
  const u = await one<{ id: string; email: string }>(
    db,
    `SELECT id, email FROM users WHERE lower(email)=lower($1) AND kind='super_admin' AND status='active'`,
    [email],
  );
  if (!u) throw new BundleRefused(`${email} is not an active super admin of this install`);
  return u;
}

async function makePlan(db: Tx, b: Bundle, email: string) {
  const who = await author(db, email);
  const items: PlanItem[] = [];
  const add = (kind: PlanItem['kind'], label: string, action: ItemAction, reason?: string) =>
    items.push({ kind, label, action, ...(reason ? { reason } : {}) });
  const skipped = new Set<string>();
  const known = new Set<string>(); // created or present: a share may hang off it

  // the launch posts of this install (`blog-launch-2026-10`): created at boot, never shared
  for (const p of b.posts) {
    const label = `post ${p.slug}`;
    const byId = await one(db, 'SELECT slug, content_hash FROM blog_posts WHERE id=$1', [p.id]);
    if (byId) {
      if (byId.slug === p.slug && byId.content_hash === p.contentHash) {
        add('post', label, 'present');
        known.add(p.id);
      } else add('post', label, 'conflict', 'the id exists with another slug or content');
      continue;
    }
    const bySlug = await one(
      db,
      'SELECT id, launch, origin_system, origin_kind FROM blog_posts WHERE slug=$1',
      [p.slug],
    );
    if (bySlug) {
      if (p.launch && bySlug.launch && !bySlug.origin_system && bySlug.origin_kind === 'writer') {
        add('post', label, 'launch-present', `this install's ${BLOG_LAUNCH_MIGRATION} article`);
        skipped.add(p.id);
      } else add('post', label, 'conflict', 'the slug exists under another id');
      continue;
    }
    add('post', label, 'create');
    known.add(p.id);
  }
  for (const r of b.releases) {
    const label = `release ${r.ref}`;
    const byId = await one(db, 'SELECT kind, ref FROM social_posts WHERE id=$1', [r.id]);
    if (byId) {
      if (byId.kind === 'release' && byId.ref === r.ref) {
        add('release', label, 'present');
        known.add(r.id);
      } else add('release', label, 'conflict', 'the id exists as another post');
      continue;
    }
    if (await one(db, `SELECT 1 FROM social_posts WHERE kind='release' AND ref=$1`, [r.ref])) {
      add('release', label, 'conflict', 'a post for this release exists under another id');
      continue;
    }
    add('release', label, 'create');
    known.add(r.id);
  }
  const inBundle = new Set(b.videos.map((v) => v.id));
  for (const v of b.videos) {
    const label = `video ${v.kind}/${v.ref}/${v.format}`;
    const byId = await one(db, 'SELECT kind, ref, format FROM video_posts WHERE id=$1', [v.id]);
    if (byId) {
      if (byId.kind === v.kind && byId.ref === v.ref && byId.format === v.format) {
        add('video', label, 'present');
        known.add(v.id);
      } else add('video', label, 'conflict', 'the id exists as another video');
      continue;
    }
    if (
      await one(db, 'SELECT 1 FROM video_posts WHERE kind=$1 AND ref=$2 AND format=$3', [
        v.kind,
        v.ref,
        v.format,
      ])
    ) {
      add('video', label, 'conflict', 'a video for this kind, ref and format exists under another id');
      continue;
    }
    if (
      v.parentId &&
      !inBundle.has(v.parentId) &&
      !(await one(db, 'SELECT 1 FROM video_posts WHERE id=$1', [v.parentId]))
    ) {
      add('video', label, 'conflict', 'its long video is neither in the bundle nor on this install');
      continue;
    }
    add('video', label, 'create');
    known.add(v.id);
  }
  for (const s of b.shares) {
    const label = `share ${s.source}/${s.network} of ${s.postId}`;
    if (skipped.has(s.postId)) {
      add('share', label, 'launch-present', 'its post is skipped');
      continue;
    }
    const row = await one(
      db,
      'SELECT status, external_id, source FROM social_shares WHERE post_id=$1 AND network=$2',
      [s.postId, s.network],
    );
    if (row) {
      if (row.status === 'sent' && row.external_id === s.externalId && row.source === s.source)
        add('share', label, 'present');
      else add('share', label, 'conflict', `a ${row.status} share row exists for it`);
      continue;
    }
    if (!known.has(s.postId)) {
      add('share', label, 'conflict', 'its post is not imported');
      continue;
    }
    add('share', label, 'create');
  }
  const counts = { create: 0, present: 0, 'launch-present': 0, conflict: 0 } as Record<ItemAction, number>;
  for (const i of items) counts[i.action]++;
  return {
    plan: { bundleId: b.id, author: who, items, counts, conflicts: counts.conflict } as ImportPlan,
    skipped,
  };
}

/** The plan only, in a read-only transaction: nothing is written. */
export async function planImport(pool: pg.Pool, b: Bundle, email: string): Promise<ImportPlan> {
  return withTx(pool, async (tx) => {
    await tx.query('SET TRANSACTION READ ONLY');
    return (await makePlan(tx, b, email)).plan;
  });
}

export interface ImportEnv {
  pool: pg.Pool;
  store: EventStore;
  clock: Clock;
}

/**
 * Plans again under the append lock and, when nothing conflicts, writes every `create` item in one transaction:
 * the events (parents before children) and the sent share rows. Returns the plan and the number of events appended.
 */
export async function applyImport(
  env: ImportEnv,
  b: Bundle,
  email: string,
): Promise<{ plan: ImportPlan; events: number; shares: number }> {
  return withAppendTx(env.pool, async (tx) => {
    const { plan } = await makePlan(tx, b, email);
    if (plan.conflicts) return { plan, events: 0, shares: 0 };
    const create = new Set(plan.items.filter((i) => i.action === 'create').map((i) => i.label));
    const actor = userActor(plan.author.id);
    const scope = { orgId: null, projectId: null, audience: 'admin' } as const;
    const origin = { userId: plan.author.id };
    const inputs: AppendInput[] = [];
    for (const p of b.posts)
      if (create.has(`post ${p.slug}`))
        inputs.push({
          streamId: blogStream(p.id),
          expectedVersion: 'no_stream',
          actor,
          scope,
          event: {
            type: 'BlogPostImported',
            payload: {
              postId: p.id,
              content: p.content,
              contentHash: p.contentHash,
              origin,
              ...(p.originKind === 'manual' && p.authorName ? { manual: { authorName: p.authorName } } : {}),
              wasLaunch: p.launch,
              createdAt: p.createdAt,
              updatedAt: p.updatedAt,
              publishedAt: p.publishedAt,
              bundle: b.id,
            },
          } as AppendInput['event'],
        });
    for (const r of b.releases)
      if (create.has(`release ${r.ref}`))
        inputs.push({
          streamId: socialPostStream(r.id),
          expectedVersion: 'no_stream',
          actor,
          scope,
          event: {
            type: 'SocialPostImported',
            payload: {
              postId: r.id,
              kind: 'release',
              ref: r.ref,
              content: r.content,
              origin,
              createdAt: r.createdAt,
              approvedAt: r.approvedAt,
              bundle: b.id,
            },
          } as AppendInput['event'],
        });
    // long videos before the Shorts that point at them
    const videos = [...b.videos].sort((x, y) => Number(!!x.parentId) - Number(!!y.parentId));
    for (const v of videos)
      if (create.has(`video ${v.kind}/${v.ref}/${v.format}`))
        inputs.push({
          streamId: videoPostStream(v.id),
          expectedVersion: 'no_stream',
          actor,
          scope,
          event: {
            type: 'VideoPostImported',
            payload: {
              postId: v.id,
              kind: v.kind,
              format: v.format,
              ref: v.ref,
              ...(v.parentId ? { parentId: v.parentId } : {}),
              meta: v.meta,
              destinations: v.destinations,
              origin,
              createdAt: v.createdAt,
              approvedAt: v.approvedAt,
              bundle: b.id,
            },
          } as AppendInput['event'],
        });
    await env.store.append(inputs, { tx });
    let shares = 0;
    for (const s of b.shares) {
      if (!create.has(`share ${s.source}/${s.network} of ${s.postId}`)) continue;
      const r = await tx.query(
        `INSERT INTO social_shares (post_id, network, source, status, attempts, next_attempt_at, external_id, url, error,
           created_at, updated_at, detail)
         VALUES ($1,$2,$3,'sent',1,NULL,$4,$5,NULL,$6,$7,$8::jsonb)
         ON CONFLICT (post_id, network) DO NOTHING`,
        [
          s.postId,
          s.network,
          s.source,
          s.externalId,
          s.url,
          s.createdAt,
          s.updatedAt,
          JSON.stringify(s.detail),
        ],
      );
      shares += r.rowCount ?? 0;
    }
    if (inputs.length || shares)
      await tx.query(
        `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING`,
        [
          importMarker(b.id),
          env.clock.now(),
          JSON.stringify({ events: inputs.length, shares, author: plan.author.id }),
        ],
      );
    return { plan, events: inputs.length, shares };
  });
}

export function formatPlan(plan: ImportPlan, verbose = true): string {
  const lines = [
    `Bundle ${plan.bundleId}`,
    `Importer: ${plan.author.email}`,
    `create ${plan.counts.create}, present ${plan.counts.present}, launch-present ${plan.counts['launch-present']}, conflict ${plan.counts.conflict}`,
  ];
  for (const kind of ['post', 'release', 'video', 'share'] as const) {
    const of = plan.items.filter((i) => i.kind === kind);
    const by = (a: ItemAction) => of.filter((i) => i.action === a).length;
    lines.push(
      `  ${kind}s: ${of.length} (create ${by('create')}, present ${by('present')}, launch-present ${by('launch-present')}, conflict ${by('conflict')})`,
    );
  }
  const shown = plan.items.filter(
    (i) => i.action === 'conflict' || (verbose && i.kind !== 'share' && i.action !== 'present'),
  );
  for (const i of shown) lines.push(`  ${i.action.padEnd(14)} ${i.label}${i.reason ? ` - ${i.reason}` : ''}`);
  return lines.join('\n');
}

/** For tests and the report: how many rows of each table the bundle's items have on this install. */
export async function presentCounts(pool: pg.Pool, b: Bundle) {
  const n = async (sql: string, ids: string[]) => Number((await rows(pool, sql, [ids]))[0]?.n ?? 0);
  return {
    posts: await n(
      'SELECT count(*)::int AS n FROM blog_posts WHERE id = ANY($1::uuid[])',
      b.posts.map((p) => p.id),
    ),
    releases: await n(
      'SELECT count(*)::int AS n FROM social_posts WHERE id = ANY($1::uuid[])',
      b.releases.map((p) => p.id),
    ),
    videos: await n(
      'SELECT count(*)::int AS n FROM video_posts WHERE id = ANY($1::uuid[])',
      b.videos.map((p) => p.id),
    ),
  };
}
