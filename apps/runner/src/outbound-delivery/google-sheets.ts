import { createSign } from 'node:crypto';
import { type DeliverySendResult, sheetRange } from '@aom/shared';
import { redactSecrets } from '../secrets/redact.ts';

const TIMEOUT_MS = 10_000;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}

/** The service account of a downloaded JSON key, or the reason it is not one. */
export function parseServiceAccountKey(keyJson: string): ServiceAccount | { error: string } {
  let k: { type?: string; client_email?: string; private_key?: string };
  try {
    k = JSON.parse(keyJson);
  } catch {
    return { error: 'The key is not valid JSON: paste the whole file you downloaded from Google Cloud.' };
  }
  if (k.type !== 'service_account' || !k.client_email || !k.private_key)
    return { error: 'This is not a service account key (it needs type, client_email and private_key).' };
  return { clientEmail: k.client_email, privateKey: k.private_key };
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** The signed JWT (RS256) that is exchanged for an access token. */
export function signJwt(sa: ServiceAccount, nowSec: number): string {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: sa.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }),
  );
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.privateKey);
  return `${head}.${claims}.${b64url(sig)}`;
}

const cache = new Map<string, { token: string; expiresAt: number }>();
export const clearTokenCache = (): void => cache.clear();

/** An access token, cached in memory until 60 s before it expires. */
async function accessToken(
  sa: ServiceAccount,
  fetchImpl: Fetch,
  now: () => number,
): Promise<{ token: string; cached: boolean } | { error: string; final: boolean; status?: number }> {
  const hit = cache.get(sa.clientEmail);
  if (hit && hit.expiresAt - 60_000 > now()) return { token: hit.token, cached: true };
  try {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(sa, Math.floor(now() / 1000)),
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (res.status === 200 && body.access_token) {
      cache.set(sa.clientEmail, { token: body.access_token, expiresAt: now() + (body.expires_in ?? 3600) * 1000 });
      return { token: body.access_token, cached: false };
    }
    const retry = res.status >= 500 || res.status === 429;
    return {
      error: retry
        ? `Google did not give a token (${res.status})`
        : 'Google refused the service account key: reconnect on the Integrations page',
      final: !retry,
      status: res.status,
    };
  } catch (err) {
    return {
      error: redactSecrets(`could not reach Google: ${err instanceof Error ? err.message : String(err)}`).slice(0, 200),
      final: false,
    };
  }
}

export interface SheetAppend {
  spreadsheetId: string;
  sheet: string;
  row: string[];
}

/** Appends one row. `RAW`: agent text that starts with `=` stays text (no formula injection). */
export async function appendSheetRow(
  sa: ServiceAccount,
  m: SheetAppend,
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): Promise<DeliverySendResult> {
  const t = await accessToken(sa, fetchImpl, now);
  if ('error' in t) return { ok: false, error: t.error, retryable: !t.final, ...(t.status ? { httpStatus: t.status } : {}) };
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(m.spreadsheetId)}/values/${encodeURIComponent(sheetRange(m.sheet))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
    const res = await fetchImpl(url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.token}` },
      body: JSON.stringify({ values: [m.row] }),
    });
    if (res.status >= 200 && res.status < 300) {
      await res.arrayBuffer().catch(() => undefined);
      return { ok: true, httpStatus: res.status, retryable: false };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
    if (res.status === 401) {
      cache.delete(sa.clientEmail);
      return {
        ok: false,
        httpStatus: 401,
        error: 'Google refused the access token',
        // A cached token may simply have been revoked early: one more try gets a new one.
        retryable: t.cached,
      };
    }
    if (res.status === 403 || res.status === 404)
      return {
        ok: false,
        httpStatus: res.status,
        error: `the sheet was not found or is not shared: share it with ${sa.clientEmail} as Editor`,
        retryable: false,
      };
    const msg = (body.error?.message ?? '').slice(0, 200);
    return {
      ok: false,
      httpStatus: res.status,
      error: redactSecrets(`Google Sheets answered ${res.status}${msg ? `: ${msg}` : ''}`).slice(0, 300),
      retryable: res.status >= 500 || res.status === 429 || res.status === 408,
    };
  } catch (err) {
    return {
      ok: false,
      error: redactSecrets(`could not reach Google Sheets: ${err instanceof Error ? err.message : String(err)}`).slice(0, 200),
      retryable: true,
    };
  }
}

/** Checks a key by exchanging it for a token. */
export async function checkServiceAccount(
  sa: ServiceAccount,
  fetchImpl: Fetch = fetch,
  now: () => number = Date.now,
): Promise<{ ok: true } | { ok: false; error: string; refused: boolean }> {
  cache.delete(sa.clientEmail);
  const t = await accessToken(sa, fetchImpl, now);
  return 'error' in t ? { ok: false, error: t.error, refused: t.final } : { ok: true };
}
