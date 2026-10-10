import type { PublicBlogPost } from '@aom/shared';
import { signValue, verifySigned } from '../auth/secrets.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { digestMail } from '../mail/blog-mail.ts';
import { blogSettings, listPublished } from './blog.ts';
import { SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * The weekly digest (docs/design/blog-prd.md section 11, owner decisions G4/G5).
 *
 * - Due Mondays 08:00 Africa/Johannesburg (UTC+2, no daylight saving: 06:00 UTC). The digest id is the ISO week, so a
 *   week has at most one digest however often the tick runs or the server restarts.
 * - Recipients: active org Owners unless they opted out; everyone else only if they opted in (checkbox at sign-up and
 *   invitation acceptance, user settings). Users whose organizations are all suspended or cancelled are skipped.
 *   One mail per address.
 * - Exactly once: a delivery row is claimed (`sent`) before the mail goes out and reverted only when sending threw, so
 *   a crash never causes a second mail to the same person for the same digest.
 * - No new posts: nothing is sent and the skip is recorded.
 */

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
const DAY = 86400_000;
const MAX_POSTS = 10;
const MAX_ATTEMPTS = 3;

const UNSUB = 'blog-unsubscribe';
export const unsubscribeToken = (ctx: Ctx, userId: string) => signValue(ctx, UNSUB, userId);
export const userOfUnsubscribeToken = (ctx: Ctx, token: string) => verifySigned(ctx, UNSUB, token);
export const unsubscribeUrl = (ctx: Ctx, token: string) =>
  `${ctx.config.publicOrigin}/blog/unsubscribe/${token}`;

/** The most recent Monday 08:00 Africa/Johannesburg (06:00 UTC) at or before `now`. */
export function lastDigestDue(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  if (d > now) d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

/** `blog-digest-2026-W41`: ISO week of the due Monday. */
export function digestIdFor(due: Date): string {
  const t = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // the Thursday decides the year
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return `blog-digest-${y}-W${String(week).padStart(2, '0')}`;
}

// ---- preferences

export async function digestPreference(
  ctx: Ctx,
  userId: string,
): Promise<{ optedIn: boolean; isOwner: boolean }> {
  const owner = !!(await one(
    ctx.pool,
    `SELECT 1 FROM org_members WHERE user_id=$1 AND role='owner' AND status='active'`,
    [userId],
  ));
  const p = await one(ctx.pool, 'SELECT opted_in FROM blog_digest_prefs WHERE user_id=$1', [userId]);
  return { optedIn: p ? p.opted_in : owner, isOwner: owner };
}

export async function setDigestPreference(
  ctx: Ctx,
  userId: string,
  optedIn: boolean,
  via: 'signup' | 'invite' | 'settings' | 'link',
): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO blog_digest_prefs (user_id, opted_in, via, updated_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET opted_in=EXCLUDED.opted_in, via=EXCLUDED.via, updated_at=EXCLUDED.updated_at`,
    [userId, optedIn, via, ctx.clock.now()],
  );
  // the consent record (who chose what, how, when)
  await ctx.store.append([
    {
      streamId: `user-${userId}`,
      event: { type: 'UserDigestPreferenceSet', payload: { userId, optedIn, via } },
      actor: via === 'link' ? SYSTEM_ACTOR : userActor(userId),
      scope: { orgId: null, projectId: null, audience: 'user', userId },
    },
  ]);
}

// ---- recipients

/** Active, deliverable people for the digest, one per address. */
export async function digestRecipients(
  ctx: Ctx,
): Promise<Array<{ userId: string; email: string; name: string }>> {
  const rs = await rows(
    ctx.pool,
    `SELECT DISTINCT ON (lower(u.email)) u.id, u.email, u.display_name
       FROM users u
       LEFT JOIN blog_digest_prefs p ON p.user_id = u.id
      WHERE u.kind='user' AND u.status='active' AND u.email <> ''
        AND EXISTS (SELECT 1 FROM org_members m JOIN organizations o ON o.id = m.org_id
                     WHERE m.user_id = u.id AND m.status='active' AND o.status IN ('trial','active'))
        AND COALESCE(p.opted_in,
              EXISTS (SELECT 1 FROM org_members m2 WHERE m2.user_id = u.id AND m2.role='owner' AND m2.status='active'))
      ORDER BY lower(u.email), u.created_at`,
  );
  return rs.map((r) => ({ userId: r.id, email: r.email, name: r.display_name }));
}

// ---- the tick

export interface DigestResult {
  digestId: string;
  state: 'skipped' | 'sent' | 'sending' | 'none';
  sent: number;
}

export async function blogDigestTick(ctx: Ctx): Promise<DigestResult> {
  const settings = await blogSettings(ctx);
  const now = ctx.clock.now();
  const due = lastDigestDue(now);
  const digestId = digestIdFor(due);
  // A digest is due on Monday morning; a server that was down then still sends it for two days, never later.
  if (now.getTime() - due.getTime() > 2 * DAY) return { digestId, state: 'none', sent: 0 };
  if (!ctx.config.blogDigest || !settings.enabled || !settings.digestEnabled)
    return { digestId, state: 'none', sent: 0 };

  let d = await one(ctx.pool, 'SELECT * FROM blog_digests WHERE digest_id=$1', [digestId]);
  if (!d) {
    const last = await one(
      ctx.pool,
      `SELECT max(cutoff) AS t FROM blog_digests WHERE state IN ('sending','sent')`,
    );
    const since = last?.t ? new Date(last.t) : new Date(now.getTime() - 7 * DAY);
    const found = await rows(
      ctx.pool,
      `SELECT id FROM blog_posts WHERE status='published' AND NOT launch AND published_at > $1 AND published_at <= $2
        ORDER BY published_at DESC LIMIT ${MAX_POSTS}`,
      [since, now],
    );
    const ids = found.map((r) => r.id as string);
    const state = ids.length ? 'sending' : 'skipped';
    const inserted = await exec(
      ctx.pool,
      `INSERT INTO blog_digests (digest_id, cutoff, post_ids, state, created_at, finished_at, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (digest_id) DO NOTHING`,
      [digestId, now, ids, state, now, ids.length ? null : now, ids.length ? null : 'no new posts'],
    );
    if (inserted && !ids.length) {
      await ctx.store.append([
        {
          streamId: `blog-digest-${digestId}`,
          event: { type: 'BlogDigestSkipped', payload: { digestId, reason: 'no new posts' } },
          actor: SYSTEM_ACTOR,
          scope: adminScope,
        },
      ]);
    }
    d = await one(ctx.pool, 'SELECT * FROM blog_digests WHERE digest_id=$1', [digestId]);
    if (d?.state === 'sending') {
      const people = await digestRecipients(ctx);
      for (const r of people)
        await exec(
          ctx.pool,
          `INSERT INTO blog_digest_deliveries (digest_id, user_id, email, state) VALUES ($1,$2,$3,'pending')
           ON CONFLICT DO NOTHING`,
          [digestId, r.userId, r.email],
        );
    }
  }
  if (!d) return { digestId, state: 'none', sent: 0 };
  if (d.state === 'skipped') return { digestId, state: 'skipped', sent: 0 };
  if (d.state === 'sent') return { digestId, state: 'sent', sent: 0 };

  // sending (or resuming after a restart): the posts of the digest, in the order of publication
  const published = await listPublished(ctx, { limit: 100 });
  const ids = d.post_ids as string[];
  const bySlug = new Map(published.posts.map((p) => [p.slug, p]));
  const idRows = await rows(ctx.pool, 'SELECT id, slug FROM blog_posts WHERE id = ANY($1::uuid[])', [ids]);
  const posts: PublicBlogPost[] = [];
  for (const id of ids) {
    const slug = idRows.find((r) => r.id === id)?.slug;
    const p = slug ? bySlug.get(slug) : undefined;
    if (p) posts.push(p);
  }

  let sent = 0;
  // a failed send is retried on a later pass (the next tick), not in a tight loop
  const failedNow: string[] = [];
  for (;;) {
    const claimed = await one(
      ctx.pool,
      `UPDATE blog_digest_deliveries x SET state='sent', attempts=attempts+1, sent_at=$2
        WHERE (x.digest_id, x.user_id) = (
          SELECT digest_id, user_id FROM blog_digest_deliveries
           WHERE digest_id=$1 AND state IN ('pending','failed') AND attempts < ${MAX_ATTEMPTS}
             AND user_id <> ALL($3::uuid[])
           ORDER BY user_id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING x.user_id, x.email`,
      [digestId, now, failedNow],
    );
    if (!claimed) break;
    const u = await one(ctx.pool, 'SELECT display_name, status FROM users WHERE id=$1', [claimed.user_id]);
    // someone who opted out between the list and now is not mailed
    const pref = await digestPreference(ctx, claimed.user_id);
    if (!u || u.status !== 'active' || !pref.optedIn || posts.length === 0) {
      await exec(
        ctx.pool,
        `UPDATE blog_digest_deliveries SET state='failed', attempts=$3 WHERE digest_id=$1 AND user_id=$2`,
        [digestId, claimed.user_id, MAX_ATTEMPTS],
      );
      continue;
    }
    try {
      await ctx.mailer.send(
        digestMail({
          to: claimed.email,
          name: u.display_name,
          digestId,
          posts,
          origin: ctx.config.publicOrigin,
          unsubscribeUrl: unsubscribeUrl(ctx, await unsubscribeToken(ctx, claimed.user_id)),
        }),
      );
      sent++;
    } catch (err) {
      ctx.log.error({ err, userId: claimed.user_id }, 'digest mail failed');
      failedNow.push(claimed.user_id);
      await exec(
        ctx.pool,
        `UPDATE blog_digest_deliveries SET state='failed' WHERE digest_id=$1 AND user_id=$2`,
        [digestId, claimed.user_id],
      );
    }
  }

  const open = await one(
    ctx.pool,
    `SELECT count(*)::int AS n FROM blog_digest_deliveries WHERE digest_id=$1 AND state IN ('pending','failed') AND attempts < ${MAX_ATTEMPTS}`,
    [digestId],
  );
  if (!open?.n) {
    const total = (
      await one(
        ctx.pool,
        `SELECT count(*)::int AS n FROM blog_digest_deliveries WHERE digest_id=$1 AND state='sent'`,
        [digestId],
      )
    )?.n as number;
    const closed = await exec(
      ctx.pool,
      `UPDATE blog_digests SET state='sent', recipients=$2, finished_at=$3 WHERE digest_id=$1 AND state='sending'`,
      [digestId, total, now],
    );
    if (closed)
      await ctx.store.append([
        {
          streamId: `blog-digest-${digestId}`,
          event: {
            type: 'BlogDigestSent',
            payload: { digestId, cutoff: new Date(d.cutoff).toISOString(), postIds: ids, recipients: total },
          },
          actor: SYSTEM_ACTOR,
          scope: adminScope,
        },
      ]);
    return { digestId, state: 'sent', sent };
  }
  return { digestId, state: 'sending', sent };
}

/** "Send a test to me": the current digest layout with the latest posts, to one address. */
export async function digestTestMail(ctx: Ctx, to: string, userId: string): Promise<number> {
  const { posts } = await listPublished(ctx, { limit: MAX_POSTS });
  if (!posts.length) return 0;
  await ctx.mailer.send(
    digestMail({
      to,
      name: 'there',
      digestId: 'blog-digest-test',
      posts,
      origin: ctx.config.publicOrigin,
      unsubscribeUrl: unsubscribeUrl(ctx, await unsubscribeToken(ctx, userId)),
    }),
  );
  return posts.length;
}
