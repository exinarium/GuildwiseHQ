import { type BlogContent, stripCiteTags } from '@aom/shared';
import { blogStream, contentHash, contentWarnings } from '../commands/blog.ts';
import { SYSTEM_ACTOR } from '../commands/common.ts';
import { exec, one, rows as selectRows } from '../db/sql.ts';
import type { DataMigrationEnv } from './orgs.ts';

/**
 * `blog-cite-cleanup-2026-10`: the blog writer used to store the web search's citation markup
 * (`(cite index="23-2">...</cite>`) in the article text, where readers saw it as literal text. This removes only those
 * `<cite>` tags (the cited text stays) from every existing post, as one `BlogPostRevised` event per changed post (the
 * state, publication date and review status of a post are untouched; a projection rebuild reproduces the result).
 * Recorded once in `data_migrations`, under an advisory lock; a second boot does nothing.
 */
export const BLOG_CITE_CLEANUP_MIGRATION = 'blog-cite-cleanup-2026-10';
const LOCK_ID = 7336;

/** Every string of the content cleaned, the structure untouched. */
function clean<T>(v: T): T {
  if (typeof v === 'string') return stripCiteTags(v) as T;
  if (Array.isArray(v)) return v.map(clean) as T;
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)])) as T;
  return v;
}

export interface BlogCiteCleanupReport {
  checked: number;
  changed: string[];
}

export async function migrateBlogCiteCleanup(env: DataMigrationEnv): Promise<BlogCiteCleanupReport | null> {
  const { pool, store, clock, log } = env;
  if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [BLOG_CITE_CLEANUP_MIGRATION]))
    return null;
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    if (await one(pool, 'SELECT 1 FROM data_migrations WHERE name=$1', [BLOG_CITE_CLEANUP_MIGRATION]))
      return null;
    const rows = await selectRows<{ id: string; slug: string; content: BlogContent }>(
      pool,
      'SELECT id, slug, content FROM blog_posts ORDER BY created_at',
    );
    const report: BlogCiteCleanupReport = { checked: rows.length, changed: [] };
    const scope = { orgId: null, projectId: null, audience: 'admin' } as const;
    for (const r of rows) {
      if (!/<\/?\s*cite\b/i.test(JSON.stringify(r.content))) continue;
      const content = clean(r.content);
      await store.append([
        {
          streamId: blogStream(r.id),
          event: {
            type: 'BlogPostRevised',
            payload: {
              postId: r.id,
              content,
              contentHash: contentHash(content),
              by: {},
              resubmit: false,
              warnings: contentWarnings(content),
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
      ] as never);
      report.changed.push(r.slug);
    }
    await exec(
      pool,
      `INSERT INTO data_migrations (name, completed_at, summary) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO NOTHING`,
      [BLOG_CITE_CLEANUP_MIGRATION, clock.now(), JSON.stringify(report)],
    );
    log(
      `${BLOG_CITE_CLEANUP_MIGRATION}: ${report.changed.length} of ${report.checked} blog post(s) cleaned of citation tags`,
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
