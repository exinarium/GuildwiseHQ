import { createHmac, randomBytes } from 'node:crypto';

/** OAuth 1.0a request signing (RFC 5849, HMAC-SHA1), just enough for X's user-context API. No dependencies. */

/** RFC 3986 percent-encoding (encodeURIComponent leaves `!'()*` alone, OAuth does not). */
export const percentEncode = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface OAuth1Input {
  method: string;
  /** The URL without query string. */
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  /** Query and form-encoded body parameters. A JSON body contributes nothing here. */
  params?: Record<string, string>;
  nonce?: string;
  timestamp?: string;
}

export function oauth1Params(i: OAuth1Input): Record<string, string> {
  return {
    oauth_consumer_key: i.consumerKey,
    oauth_nonce: i.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: i.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: i.token,
    oauth_version: '1.0',
  };
}

export function oauth1Signature(i: OAuth1Input, oauth: Record<string, string>): string {
  const pairs = Object.entries({ ...(i.params ?? {}), ...oauth })
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const base = [i.method.toUpperCase(), percentEncode(i.url), percentEncode(pairs)].join('&');
  const key = `${percentEncode(i.consumerSecret)}&${percentEncode(i.tokenSecret)}`;
  return createHmac('sha1', key).update(base).digest('base64');
}

/** The `Authorization` header value. */
export function oauth1Header(i: OAuth1Input): string {
  const oauth = oauth1Params(i);
  const all = { ...oauth, oauth_signature: oauth1Signature(i, oauth) };
  return `OAuth ${Object.entries(all)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ')}`;
}
