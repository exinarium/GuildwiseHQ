import { createHash, createHmac } from 'node:crypto';

const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();
const hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** RFC 3986 encoding as SigV4 wants it; `/` is kept in paths. */
export function uriEncode(s: string, keepSlash = false): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export interface SignInput {
  method: string;
  host: string;
  /** Already URI-encoded path, starting with `/`. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now: Date;
}

/** AWS Signature Version 4 (header form). Returns the headers to send. */
export function signV4(i: SignInput): Record<string, string> {
  const amz = i.now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const date = amz.slice(0, 8);
  const service = i.service ?? 's3';
  const headers: Record<string, string> = {
    ...(i.headers ?? {}),
    host: i.host,
    'x-amz-content-sha256': i.payloadHash,
    'x-amz-date': amz,
  };
  if (i.sessionToken) headers['x-amz-security-token'] = i.sessionToken;
  const names = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = Object.entries(i.query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [i.method, i.path, query, canonicalHeaders, signedHeaders, i.payloadHash].join('\n');
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${i.secretAccessKey}`, date);
  const kRegion = hmac(kDate, i.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** Exposed for the signature test vectors. */
export const _internal = { canonicalRequestHash: hex };

export interface PresignInput {
  method: string;
  host: string;
  /** Already URI-encoded path, starting with `/`. */
  path: string;
  /** Headers the browser must send exactly as signed (besides `host`). */
  headers?: Record<string, string>;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Seconds the URL stays valid (1..604800). */
  expires: number;
  now: Date;
}

/** AWS Signature Version 4 in query form (a presigned URL). Returns the query string without a leading `?`. */
export function presignV4(i: PresignInput): string {
  const amz = i.now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const date = amz.slice(0, 8);
  const service = i.service ?? 's3';
  const scope = `${date}/${i.region}/${service}/aws4_request`;
  const lower: Record<string, string> = { host: i.host };
  for (const [k, v] of Object.entries(i.headers ?? {}))
    lower[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const names = Object.keys(lower).sort();
  const signedHeaders = names.join(';');
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${i.accessKeyId}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(Math.max(1, Math.min(604800, Math.floor(i.expires)))),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  if (i.sessionToken) params['X-Amz-Security-Token'] = i.sessionToken;
  const query = Object.entries(params)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const canonical = [i.method, i.path, query, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, hex(canonical)].join('\n');
  const kSigning = hmac(
    hmac(hmac(hmac(`AWS4${i.secretAccessKey}`, date), i.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  return `${query}&X-Amz-Signature=${signature}`;
}
