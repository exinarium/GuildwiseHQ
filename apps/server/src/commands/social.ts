import {
  BLOG_AUTHOR,
  type BlogContent,
  type ConnectSocialChannelRequest,
  SOCIAL_CHANNEL_NETWORKS,
  type SocialCaptions,
  type SocialChannel,
  type SocialChannelNetwork,
  type SocialNetwork,
  type SocialPostContent,
  type VideoSocialPostContent,
} from '@aom/shared';
import { decryptSecret, encryptSecret } from '../auth/secrets.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { getRelease } from '../blog/releases.ts';
import { SocialError } from '../blog/social-client.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, rows } from '../db/sql.ts';
import { badRequest } from '../errors.ts';
import { socialAlertMail } from '../mail/blog-mail.ts';
import { DestinationError } from '../video/destinations.ts';
import { YouTubeError } from '../video/youtube.ts';
import { blogEnabled } from './blog.ts';
import { SYSTEM_ACTOR, userActor } from './common.ts';
import { revokeTiktok } from './tiktok.ts';

/**
 * Auto-share to the Facebook Page, the LinkedIn organization, X and Bluesky on publish.
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
  return SOCIAL_CHANNEL_NETWORKS.map((network) => {
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

type TokenInput = {
  accountId: string;
  accountName: string;
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: string | null | undefined;
};

/** X and Bluesky pastes become the same shape as a token: the secrets go into one JSON string, encrypted below. */
function normalizeConnect(network: SocialChannelNetwork, body: ConnectSocialChannelRequest): TokenInput {
  if (network === 'x') {
    if (!('apiKey' in body))
      throw badRequest('bad_credentials', 'X needs apiKey, apiSecret, accessToken and accessSecret');
    return {
      accountId: 'x',
      accountName: body.accountName,
      accessToken: JSON.stringify({
        apiKey: body.apiKey,
        apiSecret: body.apiSecret,
        accessToken: body.accessToken,
        accessSecret: body.accessSecret,
      }),
    };
  }
  if (network === 'bluesky') {
    if (!('handle' in body)) throw badRequest('bad_credentials', 'Bluesky needs handle and appPassword');
    const handle = body.handle.replace(/^@/, '');
    return {
      accountId: handle,
      accountName: handle,
      accessToken: JSON.stringify({ handle, appPassword: body.appPassword }),
    };
  }
  if (!('accountId' in body)) throw badRequest('bad_credentials', 'accountId and accessToken are required');
  return body;
}

/**
 * YouTube: the pasted refresh token is validated with a token exchange and `channels.list mine=true`, then stored
 * encrypted as `{refreshToken}`. The account id is the channel id and the name its title.
 */
async function normalizeYoutube(ctx: Ctx, body: ConnectSocialChannelRequest): Promise<TokenInput> {
  if (!('refreshToken' in body) || 'accountId' in body)
    throw badRequest('bad_credentials', 'YouTube needs a refresh token');
  const { youtubeClientId: clientId, youtubeClientSecret: clientSecret } = ctx.config;
  if (!clientId || !clientSecret)
    throw badRequest(
      'youtube_not_configured',
      'Set AOM_YOUTUBE_CLIENT_ID and AOM_YOUTUBE_CLIENT_SECRET (the OAuth client the refresh token was made with) first',
    );
  try {
    const access = await ctx.youtube.accessToken({ clientId, clientSecret, refreshToken: body.refreshToken });
    const channel = await ctx.youtube.channelMine(access);
    return {
      accountId: channel.id,
      accountName: channel.title,
      accessToken: JSON.stringify({ refreshToken: body.refreshToken }),
    };
  } catch (err) {
    if (err instanceof YouTubeError)
      throw badRequest('bad_credentials', `YouTube did not accept the refresh token: ${err.message}`);
    throw err;
  }
}

/**
 * Instagram Reels: the Instagram professional account id and a Facebook Page access token of the Page that account is
 * linked to (scopes instagram_basic, instagram_content_publish, pages_read_engagement). Checked with the Graph API.
 */
async function normalizeInstagram(ctx: Ctx, body: ConnectSocialChannelRequest): Promise<TokenInput> {
  if (!('accountId' in body)) throw badRequest('bad_credentials', 'accountId and accessToken are required');
  try {
    const ig = await ctx.videoDestinations.instagramAccount(body.accountId, body.accessToken);
    return { ...body, accountName: body.accountName || `@${ig.username}` };
  } catch (err) {
    if (err instanceof DestinationError)
      throw badRequest(
        'bad_credentials',
        `Instagram did not accept the account id and token: ${err.message}`,
      );
    throw err;
  }
}

export async function connectChannel(
  ctx: Ctx,
  by: AuthSession['user'],
  network: SocialChannelNetwork,
  body: ConnectSocialChannelRequest,
): Promise<SocialChannel[]> {
  if (network === 'tiktok')
    throw badRequest(
      'use_oauth',
      'TikTok is connected with the Connect button (it signs in on TikTok), not with pasted tokens',
    );
  const input =
    network === 'youtube'
      ? await normalizeYoutube(ctx, body)
      : network === 'instagram'
        ? await normalizeInstagram(ctx, body)
        : normalizeConnect(network, body);
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
  network: SocialChannelNetwork,
): Promise<SocialChannel[]> {
  if (network === 'tiktok') await revokeTiktok(ctx);
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

/** Latest shares of blog posts (`slug`) and release posts (`ref`); `source` says which. */
export async function listSharesForApi(ctx: Ctx) {
  const rs = await rows(
    ctx.pool,
    `SELECT s.*, p.slug AS slug, sp.ref AS ref
       FROM social_shares s
       LEFT JOIN blog_posts p ON s.source = 'blog' AND p.id = s.post_id
       LEFT JOIN social_posts sp ON s.source = 'social' AND sp.id = s.post_id
      WHERE p.id IS NOT NULL OR sp.id IS NOT NULL
      ORDER BY s.updated_at DESC LIMIT 100`,
  );
  return rs.map((r) => ({
    source: r.source as 'blog' | 'social',
    ...(r.source === 'social' ? { ref: r.ref as string } : { slug: r.slug as string }),
    ...shareRow(r),
  }));
}

/** Failed shares and channel problems, for the banner on the platform blog page. */
export async function socialProblems(
  ctx: Ctx,
): Promise<{ failedShares: number; channelsNeedingReconnect: SocialChannelNetwork[] }> {
  const f = await one(ctx.pool, `SELECT count(*)::int AS n FROM social_shares WHERE status='failed'`);
  const c = await rows(ctx.pool, `SELECT network FROM social_channels WHERE status='needs_reconnect'`);
  return { failedShares: f?.n ?? 0, channelsNeedingReconnect: c.map((x) => x.network) };
}

/**
 * Posts that have no share row yet get one per connected, healthy channel (no backlog from before the connection):
 * published blog articles, and approved release posts (`source = 'social'`, counted from their approval). Both only
 * while fresh (48 hours).
 */
async function createMissingShares(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const fresh = new Date(now.getTime() - FRESH_MS);
  await exec(
    ctx.pool,
    `INSERT INTO social_shares (post_id, network, status, attempts, next_attempt_at, created_at, updated_at)
     SELECT p.id, c.network, 'pending', 0, $1, $1, $1
       FROM blog_posts p CROSS JOIN social_channels c
      WHERE p.status='published' AND NOT p.launch AND c.status='ok' AND c.network IN ('facebook','linkedin','x','bluesky')
        AND p.published_at >= c.connected_at AND p.published_at > $2
     ON CONFLICT (post_id, network) DO NOTHING`,
    [now, fresh],
  );
  await exec(
    ctx.pool,
    `INSERT INTO social_shares (post_id, network, source, status, attempts, next_attempt_at, created_at, updated_at)
     SELECT p.id, c.network, 'social', 'pending', 0, $1, $1, $1
       FROM social_posts p CROSS JOIN social_channels c
      WHERE p.status='approved' AND c.status='ok' AND c.network IN ('facebook','linkedin','x','bluesky')
        AND p.approved_at >= c.connected_at AND p.approved_at > $2
     ON CONFLICT (post_id, network) DO NOTHING`,
    [now, fresh],
  );
}

export async function superAdminEmails(ctx: Ctx): Promise<string[]> {
  const rs = await rows(ctx.pool, `SELECT email FROM users WHERE kind='super_admin' AND status='active'`);
  return rs.map((r) => r.email as string);
}

export async function alertOnce(
  ctx: Ctx,
  network: SocialChannelNetwork,
  reason: string,
  shorts = false,
): Promise<void> {
  const claimed = await exec(
    ctx.pool,
    `UPDATE social_channels SET alerted_at=$2 WHERE network=$1 AND alerted_at IS NULL`,
    [network, ctx.clock.now()],
  );
  if (!claimed) return;
  for (const to of await superAdminEmails(ctx)) {
    try {
      await ctx.mailer.send(
        socialAlertMail({ to, network, reason, origin: ctx.config.publicOrigin, shorts }),
      );
    } catch (err) {
      ctx.log.error({ err }, 'social alert mail failed');
    }
  }
}

function captionFor(
  network: SocialNetwork,
  c: SocialCaptions,
  fallback: string,
): { text: string; tags: string[] } {
  const text = {
    facebook: c.facebookText,
    linkedin: c.linkedinText,
    x: c.xText,
    bluesky: c.blueskyText,
  }[network];
  // older posts have no X or Bluesky caption (the client cuts the summary to fit) and no hashtag array (tags stay inline)
  return { text: text || fallback, tags: c.hashtags?.[network] ?? [] };
}

/** What a share needs from the thing it shares, whichever table it lives in. */
interface Shareable {
  /** Still in the state that may be posted (published / approved). */
  live: boolean;
  /** When it became live; older than 48 hours is not posted. */
  at: Date | null;
  notLive: string;
  stream: string;
  link: string;
  title: string;
  description: string;
  imageUrl: string;
  text: string;
  tags: string[];
}

async function loadShareable(
  ctx: Ctx,
  share: Record<string, any>,
  network: SocialNetwork,
): Promise<Shareable | null> {
  const origin = ctx.config.publicOrigin;
  if (share.source === 'social') {
    const sp = await one(ctx.pool, 'SELECT * FROM social_posts WHERE id=$1', [share.post_id]);
    if (!sp) return null;
    if (sp.kind === 'video') {
      // the optional cross-post of a tutorial: the link is the YouTube watch URL of the upload
      const c = sp.content as VideoSocialPostContent;
      const yt = await one(
        ctx.pool,
        `SELECT url, status FROM social_shares WHERE post_id=$1 AND network='youtube' AND source='video'`,
        [c.videoPostId],
      );
      return {
        live: sp.status === 'approved' && yt?.status === 'sent' && !!yt.url,
        at: sp.approved_at ? new Date(sp.approved_at) : null,
        notLive: sp.status === 'approved' ? 'the video is not on YouTube' : 'post is not approved',
        stream: `social-post-${sp.id}`,
        link: yt?.url ?? '',
        title: sp.title,
        description: c.summary,
        imageUrl: `${origin}/blog/cover/${c.coverKey}.png`,
        ...captionFor(network, c.captions, c.summary),
      };
    }
    const c = sp.content as SocialPostContent;
    // a release: its own public page, with the campaign in the link so the traffic can be told apart
    const link = `${origin}/releases/${encodeURIComponent(sp.ref)}?utm_source=${network}&utm_medium=social&utm_campaign=release-${encodeURIComponent(sp.ref)}`;
    return {
      // never post a card that links to a 404: the release notes may be missing (a rollback, a build without them)
      live: sp.status === 'approved' && !!getRelease(sp.ref, ctx),
      at: sp.approved_at ? new Date(sp.approved_at) : null,
      notLive: sp.status === 'approved' ? 'release page not available' : 'post is not approved',
      stream: `social-post-${sp.id}`,
      link,
      title: sp.title,
      description: c.summary,
      imageUrl: `${origin}/blog/cover/${c.coverKey}.png`,
      ...captionFor(network, c.captions, c.summary),
    };
  }
  const post = await one(ctx.pool, 'SELECT * FROM blog_posts WHERE id=$1', [share.post_id]);
  if (!post) return null;
  const content = post.content as BlogContent;
  return {
    live: post.status === 'published',
    at: post.published_at ? new Date(post.published_at) : null,
    notLive: 'post is not published',
    stream: `blog-${post.id}`,
    link: `${origin}/blog/${post.slug}?utm_source=${network}&utm_medium=social`,
    title: post.title,
    description: post.summary,
    imageUrl: `${origin}/blog/cover/${content.coverImage.defaultKey}.png`,
    ...captionFor(network, content.social, content.summary),
  };
}

async function runShare(ctx: Ctx, share: Record<string, any>): Promise<void> {
  const network = share.network as SocialNetwork;
  const item = await loadShareable(ctx, share, network);
  const ch = await one(ctx.pool, 'SELECT * FROM social_channels WHERE network=$1', [network]);
  const now = ctx.clock.now();
  const tooOld = item?.at && item.at.getTime() < now.getTime() - FRESH_MS;
  if (!item?.live || !ch || tooOld) {
    await exec(
      ctx.pool,
      `UPDATE social_shares SET status='skipped', error=$3, updated_at=$4 WHERE post_id=$1 AND network=$2`,
      [
        share.post_id,
        network,
        !ch ? 'channel disconnected' : tooOld ? 'older than 48 hours' : (item?.notLive ?? 'post is gone'),
        now,
      ],
    );
    return;
  }
  try {
    const res = await ctx.social.post(network, {
      accountId: ch.account_id,
      accessToken: await decryptSecret(ctx, ch.access_token),
      text: item.text,
      tags: item.tags,
      link: item.link,
      title: item.title,
      description: item.description,
      imageUrl: item.imageUrl,
    });
    await exec(
      ctx.pool,
      `UPDATE social_shares SET status='sent', external_id=$3, url=$4, error=NULL, attempts=attempts+1, next_attempt_at=NULL, updated_at=$5
        WHERE post_id=$1 AND network=$2`,
      [share.post_id, network, res.externalId, res.url, now],
    );
    await ctx.store.append([
      {
        streamId: item.stream,
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
          streamId: item.stream,
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
    `SELECT * FROM social_channels WHERE status='ok' AND network NOT IN ('youtube','tiktok') AND expires_at IS NOT NULL AND expires_at < $1`,
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
      WHERE status='posting' AND source <> 'video' AND updated_at < $2`,
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
           WHERE s2.status='pending' AND s2.source <> 'video' AND s2.network IN ('facebook','linkedin','x','bluesky') AND (s2.next_attempt_at IS NULL OR s2.next_attempt_at <= $1)
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
