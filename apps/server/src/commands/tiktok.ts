import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../auth/secrets.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { DestinationError, type TikTokCreatorInfo } from '../video/destinations.ts';
import { userActor } from './common.ts';
import { videoSettings, withLock } from './video-posts.ts';

/**
 * TikTok as a social channel: OAuth connect (Login Kit, scopes user.info.basic and video.publish), token renewal (the
 * access token lasts 24 hours, the refresh token a year and may be replaced by every refresh), and the creator info the
 * Schedule step shows. Tokens are stored encrypted in `social_channels` (access_token, refresh_token); `account_id` is
 * TikTok's open_id.
 */

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
export const TIKTOK_SCOPES = 'user.info.basic,video.publish';
const STATE_PREFIX = 'tiktok_oauth_state:';
const STATE_TTL_MS = 10 * 60_000;
const REFRESH_AHEAD_MS = 30 * 60_000;

export const tiktokRedirectUri = (ctx: Ctx): string =>
  `${ctx.config.publicOrigin}/api/platform/social/tiktok/callback`;

function appCreds(ctx: Ctx): { clientKey: string; clientSecret: string } {
  const { tiktokClientKey: clientKey, tiktokClientSecret: clientSecret } = ctx.config;
  if (!clientKey || !clientSecret)
    throw badRequest(
      'tiktok_not_configured',
      'Set AOM_TIKTOK_CLIENT_KEY and AOM_TIKTOK_CLIENT_SECRET (from the TikTok developer app) first',
    );
  return { clientKey, clientSecret };
}

/** The TikTok authorize URL; the state is stored server-side (one use, 10 minutes) and bound to the admin who asked. */
export async function tiktokConnectUrl(ctx: Ctx, by: AuthSession['user']): Promise<string> {
  const { clientKey } = appCreds(ctx);
  // states nobody came back with
  await exec(ctx.pool, `DELETE FROM platform_settings WHERE key LIKE $1 AND updated_at < $2`, [
    `${STATE_PREFIX}%`,
    new Date(ctx.clock.now().getTime() - STATE_TTL_MS),
  ]);
  const state = randomBytes(24).toString('base64url');
  await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,$4)`,
    [
      `${STATE_PREFIX}${state}`,
      JSON.stringify({ userId: by.id, at: ctx.clock.now().toISOString() }),
      by.id,
      ctx.clock.now(),
    ],
  );
  const q = new URLSearchParams({
    client_key: clientKey,
    scope: TIKTOK_SCOPES,
    response_type: 'code',
    redirect_uri: tiktokRedirectUri(ctx),
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}

/** The redirect back from TikTok: checks the state, swaps the code for tokens and stores the channel. */
export async function tiktokCallback(
  ctx: Ctx,
  by: AuthSession['user'],
  query: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
    error_description?: string | undefined;
  },
): Promise<{ accountName: string }> {
  if (!query.state) throw badRequest('bad_state', 'the TikTok sign-in has no state');
  const key = `${STATE_PREFIX}${query.state}`;
  // one use, atomically: of two callbacks with the same state only one gets the row
  const row = await one(ctx.pool, 'DELETE FROM platform_settings WHERE key=$1 RETURNING value', [key]);
  const v = row?.value as { userId?: string; at?: string } | undefined;
  if (!v || v.userId !== by.id || ctx.clock.now().getTime() - Date.parse(v.at ?? '') > STATE_TTL_MS)
    throw badRequest('bad_state', 'the TikTok sign-in expired or was not started here: press Connect again');
  if (query.error) throw badRequest('tiktok_denied', `TikTok: ${query.error_description ?? query.error}`);
  if (!query.code) throw badRequest('bad_state', 'TikTok sent no authorization code');
  const app = appCreds(ctx);
  let tokens: Awaited<ReturnType<Ctx['videoDestinations']['tiktokToken']>>;
  let info: TikTokCreatorInfo;
  try {
    tokens = await ctx.videoDestinations.tiktokToken(
      { code: query.code, redirectUri: tiktokRedirectUri(ctx) },
      app,
    );
    info = await ctx.videoDestinations.tiktokCreatorInfo(tokens.accessToken);
  } catch (err) {
    if (err instanceof DestinationError) throw badRequest('tiktok_failed', err.message);
    throw err;
  }
  const accountName = info.username ? `@${info.username}` : info.nickname || tokens.openId;
  await exec(
    ctx.pool,
    `INSERT INTO social_channels (network, account_id, account_name, access_token, refresh_token, expires_at, status, connected_by, connected_at)
     VALUES ('tiktok',$1,$2,$3,$4,$5,'ok',$6,$7)
     ON CONFLICT (network) DO UPDATE SET account_id=EXCLUDED.account_id, account_name=EXCLUDED.account_name,
       access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token, expires_at=EXCLUDED.expires_at,
       status='ok', alerted_at=NULL, connected_by=EXCLUDED.connected_by`,
    [
      tokens.openId,
      accountName,
      await encryptSecret(ctx, tokens.accessToken),
      await encryptSecret(ctx, tokens.refreshToken),
      tokens.expiresAt,
      by.id,
      ctx.clock.now(),
    ],
  );
  await ctx.store.append([
    {
      streamId: 'social-tiktok',
      event: { type: 'SocialChannelConnected', payload: { network: 'tiktok', accountName, by: by.id } },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  return { accountName };
}

/**
 * A usable access token for the connected TikTok account: the stored one, or a new one when it ends within 30 minutes
 * (the refresh token TikTok sends back replaces the stored one). An `auth` DestinationError means "connect again".
 */
export async function freshTiktokToken(ctx: Ctx, first: Record<string, any>): Promise<string> {
  const stillGood = (ch: Record<string, any>) =>
    (ch.expires_at ? new Date(ch.expires_at).getTime() : 0) - ctx.clock.now().getTime() > REFRESH_AHEAD_MS;
  if (stillGood(first)) return decryptSecret(ctx, first.access_token);
  // one renewal at a time (the app and the worker both ask): whoever comes second finds the new token and uses it, so a
  // refresh token that TikTok rotated is never spent twice
  return withLock(ctx, 'tiktok-token', async () => {
    const ch = (await one(ctx.pool, `SELECT * FROM social_channels WHERE network='tiktok'`)) ?? first;
    if (stillGood(ch)) return decryptSecret(ctx, ch.access_token);
    const { tiktokClientKey: clientKey, tiktokClientSecret: clientSecret } = ctx.config;
    if (!clientKey || !clientSecret)
      throw new DestinationError('final', 'AOM_TIKTOK_CLIENT_KEY and AOM_TIKTOK_CLIENT_SECRET are not set');
    if (!ch.refresh_token)
      throw new DestinationError('auth', 'TikTok has no refresh token: connect it again');
    const fresh = await ctx.videoDestinations.tiktokToken(
      { refreshToken: await decryptSecret(ctx, ch.refresh_token) },
      { clientKey, clientSecret },
    );
    await exec(
      ctx.pool,
      `UPDATE social_channels SET access_token=$1, refresh_token=$2, expires_at=$3, alerted_at=NULL WHERE network='tiktok'`,
      [
        await encryptSecret(ctx, fresh.accessToken),
        await encryptSecret(ctx, fresh.refreshToken),
        fresh.expiresAt,
      ],
    );
    return fresh.accessToken;
  });
}

/** Revokes the stored TikTok access token (on disconnect). Best effort: a failure never blocks the disconnect. */
export async function revokeTiktok(ctx: Ctx): Promise<void> {
  const { tiktokClientKey: clientKey, tiktokClientSecret: clientSecret } = ctx.config;
  const ch = await one(ctx.pool, `SELECT access_token FROM social_channels WHERE network='tiktok'`);
  if (!ch || !clientKey || !clientSecret) return;
  try {
    await ctx.videoDestinations.tiktokRevoke(await decryptSecret(ctx, ch.access_token), {
      clientKey,
      clientSecret,
    });
  } catch (err) {
    ctx.log.warn({ err }, 'tiktok revoke failed');
  }
}

export interface TikTokCreatorDto {
  nickname: string;
  username: string;
  avatarUrl: string | null;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number | null;
  canPost: boolean;
  /** The app passed TikTok's audit (the `tiktokAudited` video setting). While false only SELF_ONLY is offered. */
  audited: boolean;
}

/** The creator info for the Schedule step. 400 not configured, 404 not connected, 409 when the token must be renewed by hand. */
export async function tiktokCreator(ctx: Ctx): Promise<TikTokCreatorDto> {
  appCreds(ctx);
  const ch = await one(ctx.pool, `SELECT * FROM social_channels WHERE network='tiktok'`);
  if (!ch) throw notFound('TikTok is not connected', 'tiktok_not_connected');
  if (ch.status !== 'ok') throw conflict('tiktok_reconnect', 'TikTok needs to be connected again');
  try {
    const token = await freshTiktokToken(ctx, ch);
    const info = await ctx.videoDestinations.tiktokCreatorInfo(token);
    const audited = (await videoSettings(ctx)).tiktokAudited;
    // an app that has not passed the audit can only post privately
    const options = audited
      ? info.privacyLevelOptions
      : info.privacyLevelOptions.filter((o) => o === 'SELF_ONLY');
    return { ...info, privacyLevelOptions: options, canPost: options.length > 0, audited };
  } catch (err) {
    if (err instanceof DestinationError) {
      if (err.kind === 'auth') {
        await exec(ctx.pool, `UPDATE social_channels SET status='needs_reconnect' WHERE network='tiktok'`);
        throw conflict('tiktok_reconnect', err.message);
      }
      throw new HttpError(502, 'tiktok_unavailable', err.message);
    }
    throw err;
  }
}
