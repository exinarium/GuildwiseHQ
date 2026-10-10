import {
  BLOG_AUTHOR,
  type BlogContent,
  SOCIAL_NETWORKS,
  type SocialChannel,
  type SocialNetwork,
} from '@aom/shared';
import { decryptSecret, encryptSecret } from '../auth/secrets.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { SocialError } from '../blog/social-client.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, rows } from '../db/sql.ts';
import { badRequest } from '../errors.ts';
import { socialAlertMail } from '../mail/blog-mail.ts';
import { blogEnabled } from './blog.ts';
import { SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * Auto-share to the Facebook Page and the LinkedIn organization on publish (docs/design/blog-prd.md section 12).
 *
 * - One `social_shares` row per post and network (primary key): a second post to the same network is impossible. The
 *   row is claimed (`posting`) before the call; a crash in between leaves it `posting`, which is turned into `failed`
 *   for the owner to look at, never retried blindly.
 * - Retries: 1 min, 5 min, 30 min, 2 h for network errors, 429 and 5xx; other 4xx is final. An authentication error
 *   marks the channel `needs_reconnect`, pauses sharing and mails the super admins once.
 * - Unpublishing a post never deletes what was shared (owner decision G6).
 * - Tokens are AES-256-GCM blobs (`auth/secrets.ts`) and appear in no event, DTO or log.
 */

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
const MIN = 60_000;
export const SHARE_BACKOFF_MS = [1 * MIN, 5 * MIN, 30 * MIN, 120 * MIN];
const FRESH_MS = 48 * 3600_000;
const STALE_POSTING_MS = 15 * MIN;
const EXPIRY_WARN_MS = 7 * 24 * 3600_000;

// ---- channels

export async function listChannels(ctx: Ctx): Promise<SocialChannel[]> {
  const rs = await rows(ctx.pool, 'SELECT * FROM social_channels');
  return SOCIAL_NETWORKS.map((network) => {
    const r = rs.find((x) => x.network === network);
    if (!r)
      return {
        network,
        connected: false,
        accountName: null,
        status: 'disconnected',
        expiresAt: null,
        connectedAt: null,
      };
    return {
      network,
      connected: true,
      accountName: r.account_name || r.account_id,
      status: r.status,
      expiresAt: iso(r.expires_at),
      connectedAt: iso(r.connected_at),
    };
  });
}

export async function connectChannel(
  ctx: Ctx,
  by: AuthSession['user'],
  network: SocialNetwork,
  input: {
    accountId: string;
    accountName: string;
    accessToken: string;
    refreshToken?: string | undefined;
    expiresAt?: string | null | undefined;
  },
): Promise<SocialChannel[]> {
  const access = await encryptSecret(ctx, input.accessToken);
  const refresh = input.refreshToken ? await encryptSecret(ctx, input.refreshToken) : null;
  await exec(
    ctx.pool,
    `INSERT INTO social_channels (network, account_id, account_name, access_token, refresh_token, expires_at, status, connected_by, connected_at)
     VALUES ($1,$2,$3,$4,$5,$6,'ok',$7,$8)
     ON CONFLICT (network) DO UPDATE SET account_id=EXCLUDED.account_id, account_name=EXCLUDED.account_name,
       access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token, expires_at=EXCLUDED.expires_at,
       status='ok', alerted_at=NULL, connected_by=EXCLUDED.connected_by`,
    [
      network,
      input.accountId,
      input.accountName,
      access,
      refresh,
      input.expiresAt ?? null,
      by.id,
      ctx.clock.now(),
    ],
  );
  await ctx.store.append([
    {
      streamId: `social-${network}`,
      event: {
        type: 'SocialChannelConnected',
        payload: { network, accountName: input.accountName || input.accountId, by: by.id },
      },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  return listChannels(ctx);
}

export async function disconnectChannel(
  ctx: Ctx,
  by: AuthSession['user'],
  network: SocialNetwork,
): Promise<SocialChannel[]> {
  const n = await exec(ctx.pool, 'DELETE FROM social_channels WHERE network=$1', [network]);
  if (n)
    await ctx.store.append([
      {
        streamId: `social-${network}`,
        event: { type: 'SocialChannelDisconnected', payload: { network, by: by.id } },
        actor: userActor(by.id),
        scope: adminScope,
      },
    ]);
  return listChannels(ctx);
}

// ---- shares

/** Rows for a post on the networks that are connected (an existing `sent` row is never touched; a `failed` one is retried). */
export async function requestShares(ctx: Ctx, postId: string, networks: SocialNetwork[]) {
  const now = ctx.clock.now();
  const chans = await rows(ctx.pool, 'SELECT network FROM social_channels');
  const have = new Set(chans.map((c) => c.network));
  if (!networks.some((n) => have.has(n)))
    throw badRequest('no_channel', 'none of these networks is connected');
  for (const network of networks) {
    if (!have.has(network)) continue;
    await exec(
      ctx.pool,
      `INSERT INTO social_shares (post_id, network, status, attempts, next_attempt_at, created_at, updated_at)
       VALUES ($1,$2,'pending',0,$3,$3,$3)
       ON CONFLICT (post_id, network) DO UPDATE SET status='pending', attempts=0, next_attempt_at=$3, error=NULL, updated_at=$3
         WHERE social_shares.status IN ('failed','skipped')`,
      [postId, network, now],
    );
  }
  return sharesForPost(ctx, postId);
}

async function sharesForPost(ctx: Ctx, postId: string) {
  const rs = await rows(ctx.pool, 'SELECT * FROM social_shares WHERE post_id=$1 ORDER BY network', [postId]);
  return rs.map(shareRow);
}
const shareRow = (r: Record<string, any>) => ({
  postId: r.post_id as string,
  network: r.network as SocialNetwork,
  status: r.status as string,
  attempts: r.attempts as number,
  externalId: (r.external_id ?? null) as string | null,
  url: (r.url ?? null) as string | null,
  error: (r.error ?? null) as string | null,
  nextAttemptAt: iso(r.next_attempt_at),
});

export async function listSharesForApi(ctx: Ctx) {
  const rs = await rows(
    ctx.pool,
    `SELECT s.*, p.slug FROM social_shares s JOIN blog_posts p ON p.id = s.post_id ORDER BY s.updated_at DESC LIMIT 100`,
  );
  return rs.map((r) => ({ slug: r.slug as string, ...shareRow(r) }));
}

/** Failed shares and channel problems, for the banner on the platform blog page. */
export async function socialProblems(
  ctx: Ctx,
): Promise<{ failedShares: number; channelsNeedingReconnect: SocialNetwork[] }> {
  const f = await one(ctx.pool, `SELECT count(*)::int AS n FROM social_shares WHERE status='failed'`);
  const c = await rows(ctx.pool, `SELECT network FROM social_channels WHERE status='needs_reconnect'`);
  return { failedShares: f?.n ?? 0, channelsNeedingReconnect: c.map((x) => x.network) };
}

/** Published posts that have no share row yet get one per connected, healthy channel (no backlog from before the connection). */
async function createMissingShares(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `INSERT INTO social_shares (post_id, network, status, attempts, next_attempt_at, created_at, updated_at)
     SELECT p.id, c.network, 'pending', 0, $1, $1, $1
       FROM blog_posts p CROSS JOIN social_channels c
      WHERE p.status='published' AND c.status='ok'
        AND p.published_at >= c.connected_at AND p.published_at > $2
     ON CONFLICT (post_id, network) DO NOTHING`,
    [now, new Date(now.getTime() - FRESH_MS)],
  );
}

async function superAdminEmails(ctx: Ctx): Promise<string[]> {
  const rs = await rows(ctx.pool, `SELECT email FROM users WHERE kind='super_admin' AND status='active'`);
  return rs.map((r) => r.email as string);
}

async function alertOnce(ctx: Ctx, network: SocialNetwork, reason: string): Promise<void> {
  const claimed = await exec(
    ctx.pool,
    `UPDATE social_channels SET alerted_at=$2 WHERE network=$1 AND alerted_at IS NULL`,
    [network, ctx.clock.now()],
  );
  if (!claimed) return;
  for (const to of await superAdminEmails(ctx)) {
    try {
      await ctx.mailer.send(socialAlertMail({ to, network, reason, origin: ctx.config.publicOrigin }));
    } catch (err) {
      ctx.log.error({ err }, 'social alert mail failed');
    }
  }
}

function captionFor(network: SocialNetwork, c: BlogContent): string {
  return (network === 'facebook' ? c.social.facebookText : c.social.linkedinText) || c.summary;
}

async function runShare(ctx: Ctx, share: Record<string, any>): Promise<void> {
  const network = share.network as SocialNetwork;
  const post = await one(ctx.pool, 'SELECT * FROM blog_posts WHERE id=$1', [share.post_id]);
  const ch = await one(ctx.pool, 'SELECT * FROM social_channels WHERE network=$1', [network]);
  const now = ctx.clock.now();
  const tooOld = post?.published_at && new Date(post.published_at).getTime() < now.getTime() - FRESH_MS;
  if (!post || post.status !== 'published' || !ch || tooOld) {
    await exec(
      ctx.pool,
      `UPDATE social_shares SET status='skipped', error=$3, updated_at=$4 WHERE post_id=$1 AND network=$2`,
      [
        share.post_id,
        network,
        !ch ? 'channel disconnected' : tooOld ? 'older than 48 hours' : 'post is not published',
        now,
      ],
    );
    return;
  }
  const content = post.content as BlogContent;
  const origin = ctx.config.publicOrigin;
  try {
    const res = await ctx.social.post(network, {
      accountId: ch.account_id,
      accessToken: await decryptSecret(ctx, ch.access_token),
      text: captionFor(network, content),
      link: `${origin}/blog/${post.slug}?utm_source=${network}&utm_medium=social`,
      title: post.title,
      description: post.summary,
      imageUrl: `${origin}/blog/cover/${content.coverImage.defaultKey}.png`,
    });
    await exec(
      ctx.pool,
      `UPDATE social_shares SET status='sent', external_id=$3, url=$4, error=NULL, attempts=attempts+1, next_attempt_at=NULL, updated_at=$5
        WHERE post_id=$1 AND network=$2`,
      [share.post_id, network, res.externalId, res.url, now],
    );
    await ctx.store.append([
      {
        streamId: `blog-${share.post_id}`,
        event: {
          type: 'SocialShareSucceeded',
          payload: { postId: share.post_id, network, externalId: res.externalId, url: res.url },
        },
        actor: SYSTEM_ACTOR,
        scope: adminScope,
      },
    ]);
  } catch (err) {
    const kind = err instanceof SocialError ? err.kind : 'retry';
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 480);
    if (kind === 'auth') {
      // not the post's fault: pause the channel, keep the share waiting for the reconnect
      await exec(ctx.pool, `UPDATE social_channels SET status='needs_reconnect' WHERE network=$1`, [network]);
      await exec(
        ctx.pool,
        `UPDATE social_shares SET status='pending', next_attempt_at=NULL, error=$3, updated_at=$4 WHERE post_id=$1 AND network=$2`,
        [share.post_id, network, message, now],
      );
      await alertOnce(ctx, network, message);
      return;
    }
    const attempts = (share.attempts as number) + 1;
    const final = kind === 'final' || attempts > SHARE_BACKOFF_MS.length;
    await exec(
      ctx.pool,
      `UPDATE social_shares SET status=$3, attempts=$4, error=$5, next_attempt_at=$6, updated_at=$7 WHERE post_id=$1 AND network=$2`,
      [
        share.post_id,
        network,
        final ? 'failed' : 'pending',
        attempts,
        message,
        final ? null : new Date(now.getTime() + (SHARE_BACKOFF_MS[attempts - 1] as number)),
        now,
      ],
    );
    if (final) {
      await ctx.store.append([
        {
          streamId: `blog-${share.post_id}`,
          event: {
            type: 'SocialShareFailed',
            payload: { postId: share.post_id, network, error: message, final: true },
          },
          actor: SYSTEM_ACTOR,
          scope: adminScope,
        },
      ]);
      await alertOnce(ctx, network, `A share failed for good: ${message}`);
    }
  }
}

/** Renews tokens that are about to expire and warns the super admins about the ones that cannot be renewed. */
async function checkExpiry(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const soon = await rows(
    ctx.pool,
    `SELECT * FROM social_channels WHERE status='ok' AND expires_at IS NOT NULL AND expires_at < $1`,
    [new Date(now.getTime() + EXPIRY_WARN_MS)],
  );
  for (const ch of soon) {
    const network = ch.network as SocialNetwork;
    try {
      if (ch.refresh_token) {
        const fresh = await ctx.social.refresh(network, await decryptSecret(ctx, ch.refresh_token), {
          ...(ctx.config.linkedinClientId ? { clientId: ctx.config.linkedinClientId } : {}),
          ...(ctx.config.linkedinClientSecret ? { clientSecret: ctx.config.linkedinClientSecret } : {}),
        });
        if (fresh) {
          await exec(
            ctx.pool,
            `UPDATE social_channels SET access_token=$2, refresh_token=$3, expires_at=$4, alerted_at=NULL WHERE network=$1`,
            [
              network,
              await encryptSecret(ctx, fresh.accessToken),
              fresh.refreshToken ? await encryptSecret(ctx, fresh.refreshToken) : null,
              fresh.expiresAt,
            ],
          );
          continue;
        }
      }
    } catch (err) {
      ctx.log.warn({ err, network }, 'social token refresh failed');
    }
    const expired = new Date(ch.expires_at) <= now;
    if (expired)
      await exec(ctx.pool, `UPDATE social_channels SET status='needs_reconnect' WHERE network=$1`, [network]);
    await alertOnce(
      ctx,
      network,
      expired
        ? 'The access token has expired.'
        : `The access token expires on ${new Date(ch.expires_at).toISOString().slice(0, 10)}.`,
    );
  }
}

/**
 * One pass: share what was published, retry what is due. While the blog is switched off nothing is posted (the token
 * checks still run, so an expiring token is still reported).
 */
export async function socialTick(ctx: Ctx): Promise<number> {
  await checkExpiry(ctx);
  if (!(await blogEnabled(ctx))) return 0;
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `UPDATE social_shares SET status='failed', error='interrupted while posting; check the page before sharing again', updated_at=$1
      WHERE status='posting' AND updated_at < $2`,
    [now, new Date(now.getTime() - STALE_POSTING_MS)],
  );
  await createMissingShares(ctx);
  let done = 0;
  for (;;) {
    // claim one: the row moves to `posting` before the call, so two ticks can never post the same share
    const claimed = await one(
      ctx.pool,
      `UPDATE social_shares s SET status='posting', updated_at=$1
        WHERE (s.post_id, s.network) = (
          SELECT s2.post_id, s2.network FROM social_shares s2
            JOIN social_channels c ON c.network = s2.network AND c.status='ok'
           WHERE s2.status='pending' AND (s2.next_attempt_at IS NULL OR s2.next_attempt_at <= $1)
           ORDER BY s2.created_at LIMIT 1 FOR UPDATE OF s2 SKIP LOCKED)
        RETURNING s.*`,
      [ctx.clock.now()],
    );
    if (!claimed) break;
    await runShare(ctx, claimed);
    done++;
    if (done >= 20) break;
  }
  return done;
}

export { BLOG_AUTHOR };
