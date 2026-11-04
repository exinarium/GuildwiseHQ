import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CLIENT_LINK_TOKEN_RE } from '@aom/shared';
import { signingKey } from '../auth/secrets.ts';
import type { Ctx } from '../context.ts';

/**
 * Signed tokens of the public forms. Each purpose has its own key (derived from the server secret), so a token of one
 * kind means nothing to another. A token holds ids and times only: never a name, an e-mail address or an answer.
 */
const mac = async (ctx: Ctx, purpose: string, data: string): Promise<string> =>
  createHmac('sha256', await signingKey(ctx, purpose))
    .update(data)
    .digest('base64url');

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const newLinkId = (): string => randomBytes(16).toString('base64url');
export const newPublicId = (): string => randomBytes(16).toString('base64url');

// ------------------------------------------------------------------------------------------- client link

/** `v1.<linkId>.<exp base36>.<hmac over v1|formId|linkId|exp>`; bound to one form. */
export async function signClientLink(ctx: Ctx, formId: string, linkId: string, expiresAt: Date): Promise<string> {
  const exp = Math.floor(expiresAt.getTime() / 1000).toString(36);
  const sig = await mac(ctx, 'form-client-link', `v1|${formId}|${linkId}|${exp}`);
  return `v1.${linkId}.${exp}.${sig}`;
}

export type ClientLinkCheck =
  | { ok: true; linkId: string; expiresAt: Date }
  | { ok: false; reason: 'invalid' | 'expired' };

/** Format, signature (constant time), then expiry. The row (revoked, used, same form) is checked by the caller. */
export async function verifyClientLink(
  ctx: Ctx,
  formId: string,
  token: string,
  now: Date = ctx.clock.now(),
): Promise<ClientLinkCheck> {
  if (!CLIENT_LINK_TOKEN_RE.test(token)) return { ok: false, reason: 'invalid' };
  const [, linkId, exp, sig] = token.split('.') as [string, string, string, string];
  const want = await mac(ctx, 'form-client-link', `v1|${formId}|${linkId}|${exp}`);
  if (!same(want, sig)) return { ok: false, reason: 'invalid' };
  const expiresAt = new Date(Number.parseInt(exp, 36) * 1000);
  if (!(expiresAt.getTime() > now.getTime())) return { ok: false, reason: 'expired' };
  return { ok: true, linkId, expiresAt };
}

// ------------------------------------------------------------------------------------------- form session

export interface FormSession {
  nonce: string;
  issuedAt: number;
  version: number;
}

/** `s1.<nonce>.<issuedAt ms base36>.<version>.<hmac over s1|formId|version|nonce|iat>`: also the proof-of-work challenge. */
export async function signSession(ctx: Ctx, formId: string, version: number, now: Date): Promise<string> {
  const nonce = randomBytes(12).toString('base64url');
  const iat = now.getTime().toString(36);
  const sig = await mac(ctx, 'form-session', `s1|${formId}|${version}|${nonce}|${iat}`);
  return `s1.${nonce}.${iat}.${version}.${sig}`;
}

/** The session when we signed it for this form (any version); age and version are judged by the caller. */
export async function verifySession(ctx: Ctx, formId: string, token: string): Promise<FormSession | null> {
  const m = /^s1\.([A-Za-z0-9_-]{16})\.([0-9a-z]{1,12})\.([0-9]{1,6})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const [, nonce, iat, version, sig] = m as unknown as [string, string, string, string, string];
  const want = await mac(ctx, 'form-session', `s1|${formId}|${version}|${nonce}|${iat}`);
  return same(want, sig)
    ? { nonce, issuedAt: Number.parseInt(iat, 36), version: Number.parseInt(version, 10) }
    : null;
}

/** Proof of work: `sha256(session + ':' + nonce)` starts with `bits` zero bits. 0 bits = off. */
export function powValid(session: string, nonce: string, bits: number): boolean {
  if (bits <= 0) return true;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(nonce)) return false;
  const h = createHash('sha256').update(`${session}:${nonce}`).digest();
  let left = bits;
  for (const byte of h) {
    if (left <= 0) return true;
    if (left >= 8) {
      if (byte !== 0) return false;
      left -= 8;
    } else {
      return byte >> (8 - left) === 0;
    }
  }
  return left <= 0;
}

// ------------------------------------------------------------------------------------------- upload token

/** `u1.<submissionId>.<exp base36>.<hmac>`: the short-lived right to add parts to one submission. */
export async function signUpload(ctx: Ctx, submissionId: string, expiresAt: Date): Promise<string> {
  const exp = Math.floor(expiresAt.getTime() / 1000).toString(36);
  const sig = await mac(ctx, 'form-upload', `u1|${submissionId}|${exp}`);
  return `u1.${submissionId}.${exp}.${sig}`;
}

/** True when the token is for this submission, signed by us and not expired. */
export async function verifyUpload(
  ctx: Ctx,
  submissionId: string,
  token: string | undefined,
  now: Date = ctx.clock.now(),
): Promise<boolean> {
  if (!token) return false;
  const m = /^u1\.([0-9a-f-]{36})\.([0-9a-z]{1,8})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const [, sid, exp, sig] = m as unknown as [string, string, string, string];
  if (sid !== submissionId) return false;
  if (!same(await mac(ctx, 'form-upload', `u1|${sid}|${exp}`), sig)) return false;
  return Number.parseInt(exp, 36) * 1000 > now.getTime();
}
