import { StorageError, type FetchLike } from './types.ts';

/** Device authorization grant (RFC 8628), run on the workstation. Tokens never leave this process except to the provider. */
export interface OAuthProvider {
  kind: 'onedrive' | 'google_drive';
  deviceUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope: string;
  revokeUrl?: string;
}

export interface OAuthEnv {
  AOM_STORAGE_MS_CLIENT_ID?: string;
  AOM_STORAGE_MS_TENANT?: string;
  AOM_STORAGE_GOOGLE_CLIENT_ID?: string;
  AOM_STORAGE_GOOGLE_CLIENT_SECRET?: string;
  [k: string]: string | undefined;
}

export const MS_SCOPE = 'offline_access Files.ReadWrite.All Sites.ReadWrite.All User.Read';
export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';

/** The provider settings for a kind, or undefined when this runner has no app configured for it. */
export function oauthProvider(kind: 'onedrive' | 'google_drive', env: OAuthEnv): OAuthProvider | undefined {
  if (kind === 'onedrive') {
    const clientId = env.AOM_STORAGE_MS_CLIENT_ID;
    if (!clientId) return undefined;
    const t = encodeURIComponent(env.AOM_STORAGE_MS_TENANT || 'common');
    return {
      kind,
      deviceUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/devicecode`,
      tokenUrl: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
      clientId,
      scope: MS_SCOPE,
    };
  }
  const clientId = env.AOM_STORAGE_GOOGLE_CLIENT_ID;
  if (!clientId) return undefined;
  return {
    kind,
    deviceUrl: 'https://oauth2.googleapis.com/device/code',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId,
    ...(env.AOM_STORAGE_GOOGLE_CLIENT_SECRET ? { clientSecret: env.AOM_STORAGE_GOOGLE_CLIENT_SECRET } : {}),
    scope: GOOGLE_SCOPE,
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
  };
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  account?: string;
}

export interface DevicePrompt {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSec: number;
}

const form = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined) as [string, string][]);

async function postForm(
  fetchFn: FetchLike,
  url: string,
  body: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new StorageError('unavailable', 'The sign-in service could not be reached.');
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return { status: res.status, json };
}

export async function beginDeviceFlow(p: OAuthProvider, fetchFn: FetchLike, now: number): Promise<DevicePrompt> {
  const { status, json } = await postForm(fetchFn, p.deviceUrl, { client_id: p.clientId, scope: p.scope });
  if (status >= 400 || typeof json.device_code !== 'string' || typeof json.user_code !== 'string') {
    if (status >= 500) throw new StorageError('unavailable', 'The sign-in service is unavailable.');
    throw new StorageError('permission', 'The sign-in service refused this app. Check its registration.');
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: String(json.verification_uri ?? json.verification_url ?? ''),
    expiresAt: now + Number(json.expires_in ?? 900) * 1000,
    intervalSec: Math.max(1, Number(json.interval ?? 5)),
  };
}

function toTokens(json: Record<string, unknown>, now: number, prevRefresh?: string): Tokens {
  const access = json.access_token;
  const refresh = (json.refresh_token as string | undefined) ?? prevRefresh;
  if (typeof access !== 'string' || !refresh)
    throw new StorageError('unavailable', 'The sign-in service answered without a token.');
  const idToken = typeof json.id_token === 'string' ? json.id_token : undefined;
  let account: string | undefined;
  if (idToken) {
    try {
      const claims = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
        email?: string;
        preferred_username?: string;
      };
      account = claims.email ?? claims.preferred_username;
    } catch {
      // no claims
    }
  }
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: now + Number(json.expires_in ?? 3600) * 1000,
    scope: String(json.scope ?? ''),
    ...(account ? { account } : {}),
  };
}

/** Polls until the user signs in, declines or the code expires. Resolves with tokens; throws a StorageError otherwise. */
export async function pollDeviceFlow(
  p: OAuthProvider,
  d: DevicePrompt,
  fetchFn: FetchLike,
  opts: { signal: AbortSignal; now: () => number; sleep: (ms: number, s: AbortSignal) => Promise<void> },
): Promise<Tokens> {
  let interval = d.intervalSec;
  for (;;) {
    await opts.sleep(interval * 1000, opts.signal);
    if (opts.signal.aborted) throw new StorageError('timeout', 'The sign-in was cancelled.');
    if (opts.now() >= d.expiresAt) throw new StorageError('timeout', 'The sign-in code expired: start again.');
    const { status, json } = await postForm(
      fetchFn,
      p.tokenUrl,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: p.clientId,
        client_secret: p.clientSecret,
        device_code: d.deviceCode,
      },
      opts.signal,
    );
    if (status < 400) return toTokens(json, opts.now());
    const err = String(json.error ?? '');
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') {
      interval += 5;
      continue;
    }
    if (err === 'expired_token') throw new StorageError('timeout', 'The sign-in code expired: start again.');
    if (err === 'access_denied' || err === 'authorization_declined')
      throw new StorageError('permission', 'The sign-in was declined (your administrator may have to approve the app).');
    if (status >= 500) continue;
    throw new StorageError('permission', 'The sign-in failed.');
  }
}

/** Gets a new access token. `invalid_grant` and `interaction_required` mean the user must sign in again. */
export async function refreshTokens(
  p: OAuthProvider,
  refreshToken: string,
  fetchFn: FetchLike,
  now: number,
): Promise<Tokens> {
  const { status, json } = await postForm(fetchFn, p.tokenUrl, {
    grant_type: 'refresh_token',
    client_id: p.clientId,
    client_secret: p.clientSecret,
    refresh_token: refreshToken,
    ...(p.kind === 'onedrive' ? { scope: p.scope } : {}),
  });
  if (status < 400) return toTokens(json, now, refreshToken);
  const err = String(json.error ?? '');
  if (err === 'invalid_grant' || err === 'interaction_required' || err === 'invalid_client' || status === 401 || status === 400)
    throw new StorageError('auth_expired', 'The sign-in expired: reconnect this storage.');
  throw new StorageError('unavailable', 'The sign-in service is unavailable.');
}

export async function revokeToken(p: OAuthProvider, token: string, fetchFn: FetchLike): Promise<void> {
  if (!p.revokeUrl) return;
  try {
    await postForm(fetchFn, p.revokeUrl, { token });
  } catch {
    // best effort
  }
}
