import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BlogContent, parseBlogArticle } from '@aom/shared';
import { blogEnabled, blogStream, contentHash, contentWarnings } from '../commands/blog.ts';
import { SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `blog-launch-2026-10`: pre-loads the launch articles (apps/server/src/blog/launch/*.md) so the public blog is not
 * empty on the first deploy. The owner has signed the content off, so the review queue is skipped, but the normal
 * rules still apply:
 *
 * - Blog switched ON (the default): each article is created PUBLISHED, `publishedAt` = the moment the migration runs
 *   (`BlogPostSubmitted` + `BlogPostPublished`, author "The Guildwise HQ team"; a projection rebuild reproduces them).
 * - Blog switched OFF (kill switch): each article is created as a DRAFT, so "off" still means nothing is published.
 *   The super admin publishes them later in Platform > Blog.
 * - Only a slug that does not exist yet is created; no other post is changed or deleted.
 * - The posts are marked `launch`: the social-share and digest jobs skip them, and they do not start the two-week
 *   review period of the writer agent.
 * - Recorded once in `data_migrations`, under an advisory lock; a second boot does nothing.
 */
export const BLOG_LAUNCH_MIGRATION = 'blog-launch-2026-10';
const LOCK_ID = 7335;
const DISCLOSURE = { model: 'Claude', agentName: 'Guildwise HQ launch set' };

const here = dirname(fileURLToPath(import.meta.url));

/** The launch articles (source tree: `../blog/launch`, bundle: `blog-launch`). */
export function loadLaunchArticles(dir?: string): BlogContent[] {
  const dirs = dir ? [dir] : [join(here, '..', 'blog', 'launch'), join(here, 'blog-launch')];
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(d)
        .filter((f) => f.endsWith('.md'))
        .sort();
    } catch {
      continue;
    }
    if (files.length) return files.map((f) => parseBlogArticle(readFileSync(join(d, f), 'utf8'), DISCLOSURE));
  }
  throw new Error('blog launch articles not found');
}

export interface BlogLaunchReport {
  created: string[];
  skipped: string[];
  status: 'published' | 'draft';
}

export async function migrateBlogLaunch(
  env: DataMigrationEnv,
  opts: { dir?: string } = {},
): Promise<BlogLaunchReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [BLOG_LAUNCH_MIGRATION])) return null;
  const articles = loadLaunchArticles(opts.dir);
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [BLOG_LAUNCH_MIGRATION])) return null;
    const on = await blogEnabled({ pool, clock } as unknown as Ctx);
    const report: BlogLaunchReport = { created: [], skipped: [], status: on ? 'published' : 'draft' };
    const scope = { orgId: null, projectId: null, audience: 'admin' } as const;
    for (const content of articles) {
      if (await one(pool, 'SELECT 1 FROM blog_posts WHERE slug=$1', [content.slug])) {
        report.skipped.push(content.slug);
        continue;
      }
      const postId = randomUUID();
      const events = [
        {
          streamId: blogStream(postId),
          event: {
            type: 'BlogPostSubmitted' as const,
            payload: {
              postId,
              content,
              contentHash: contentHash(content),
              origin: {},
              status: 'draft' as const,
              warnings: contentWarnings(content),
              launch: true,
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
      ];
      if (on)
        events.push({
          streamId: blogStream(postId),
          event: { type: 'BlogPostPublished' as never, payload: { postId, auto: false } as never },
          actor: SYSTEM_ACTOR,
          scope,
        });
      await store.append(events as never);
      report.created.push(content.slug);
    }
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO NOTHING`,
      [BLOG_LAUNCH_MIGRATION, clock.now(), JSON.stringify(report)],
    );
    log(
      `${BLOG_LAUNCH_MIGRATION}: ${report.created.length} launch article(s) created as ${report.status}, ${report.skipped.length} skipped (slug exists)`,
    );
    return report;
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    } finally {
      lock.release();
    }
  }
}
