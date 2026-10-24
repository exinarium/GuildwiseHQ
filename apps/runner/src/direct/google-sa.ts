import { createSign } from 'node:crypto';

/**
 * A Google service-account key (the JSON file Google Cloud hands out, about 2.4 KB) as the credential of the Gemini provider: the
 * runner signs a JWT with its private key, exchanges it for a short-lived access token and sends that as a bearer token instead
 * of the `x-goog-api-key` header. The key itself never leaves this process.
 */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export const GEMINI_SCOPE = 'https://www.googleapis.com/auth/generative-language';
const TOKEN_HOST = 'oauth2.googleapis.com';

export function parseServiceAccount(raw: string | undefined): ServiceAccount | undefined {
  const t = raw?.trim();
  if (!t || !t.startsWith('{')) return undefined;
  try {
    const j = JSON.parse(t) as Record<string, unknown>;
    if (j.type !== 'service_account') return undefined;
    if (typeof j.client_email !== 'string' || typeof j.private_key !== 'string') return undefined;
    return {
      client_email: j.client_email,
      private_key: j.private_key,
      token_uri: typeof j.token_uri === 'string' ? j.token_uri : `https://${TOKEN_HOST}/token`,
    };
  } catch {
    return undefined;
  }
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** The signed assertion for the JWT-bearer grant. */
export function signAssertion(sa: ServiceAccount, nowSec: number): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: GEMINI_SCOPE,
      aud: sa.token_uri,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key);
  return `${head}.${claims}.${b64url(sig)}`;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Wraps `fetch` so every call carries the service account's access token (cached until a minute before it expires). The token
 * endpoint must be Google's own, unless `allowTokenUri` (tests) says otherwise: a key file cannot point the runner elsewhere.
 */
export function serviceAccountFetch(
  sa: ServiceAccount,
  base: FetchFn,
  opts: { allowTokenUri?: boolean; now?: () => number } = {},
): FetchFn {
  const now = opts.now ?? (() => Date.now());
  let token: { value: string; until: number } | undefined;
  const mint = async (): Promise<string> => {
    if (token && token.until > now()) return token.value;
    const u = new URL(sa.token_uri);
    if (!opts.allowTokenUri && (u.protocol !== 'https:' || u.hostname !== TOKEN_HOST))
      throw new Error('the service account names a token endpoint that is not Google’s');
    const res = await base(sa.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signAssertion(sa, Math.floor(now() / 1000)),
      }).toString(),
    });
    if (!res.ok) throw new Error(`Google refused the service account (${res.status})`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new Error('Google returned no access token for the service account');
    token = { value: j.access_token, until: now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000 };
    return token.value;
  };
  return async (url, init = {}) => {
    const access = await mint();
    const headers = new Headers(init.headers);
    headers.delete('x-goog-api-key');
    headers.set('authorization', `Bearer ${access}`);
    return base(url, { ...init, headers });
  };
}
