import { createHmac, timingSafeEqual } from 'node:crypto';
import { signingKey } from '../auth/secrets.ts';
import type { Ctx } from '../context.ts';
import { HttpError } from '../errors.ts';

/**
 * Signed, attempt-bound links of the render job API (core DESIGN R16): the input fetch and each upload. HMAC-SHA256 with
 * `signingKey(ctx, 'render-io')` over the method, render id, attempt, name and expiry. A link is only half of the
 * credential: the worker's bearer token is required as well, and the server checks that the render is still held by
 * that attempt (and worker). `sig=` and `exp=` are redacted from every log (app.ts `redactUrl`).
 */

const PURPOSE = 'render-io';

export interface RenderIoClaim {
  method: 'GET' | 'PUT';
  renderId: string;
  attempt: number;
  /** `input`, or the artifact file name of an upload. */
  name: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

async function mac(ctx: Ctx, c: RenderIoClaim): Promise<string> {
  return createHmac('sha256', await signingKey(ctx, PURPOSE))
    .update(`${c.method}\n${c.renderId}\n${c.attempt}\n${c.name}\n${c.exp}`)
    .digest('base64url');
}

/** The query string (`attempt=..&exp=..&sig=..`) of a signed link valid for `ttlMs`. */
export async function signedQuery(
  ctx: Ctx,
  c: Omit<RenderIoClaim, 'exp'>,
  ttlMs: number,
  /** A fixed expiry instead of now + ttl: the claim gives all its upload links one, which identifies the claim. */
  fixedExp?: number,
): Promise<string> {
  const exp = fixedExp ?? ctx.clock.now().getTime() + ttlMs;
  const sig = await mac(ctx, { ...c, exp });
  return `attempt=${c.attempt}&exp=${exp}&sig=${sig}`;
}

export const inputPath = (renderId: string) => `/api/render/jobs/${renderId}/input`;
export const uploadPath = (renderId: string, name: string) =>
  `/api/worker/video/renders/${renderId}/files/${encodeURIComponent(name)}`;

/**
 * Checks a signed link's query for this method, render and name. Returns the attempt it is bound to. A missing, tampered
 * or foreign signature is 403 `bad_signature`; an expired one 403 `link_expired`.
 */
export async function verifySignedQuery(
  ctx: Ctx,
  c: { method: 'GET' | 'PUT'; renderId: string; name: string },
  query: { attempt?: unknown; exp?: unknown; sig?: unknown },
): Promise<number> {
  return (await verifySignedLink(ctx, c, query)).attempt;
}

/** As `verifySignedQuery`, also returning the link's expiry (the claim's identity for upload slots). */
export async function verifySignedLink(
  ctx: Ctx,
  c: { method: 'GET' | 'PUT'; renderId: string; name: string },
  query: { attempt?: unknown; exp?: unknown; sig?: unknown },
): Promise<{ attempt: number; exp: number }> {
  const attempt = Number(query.attempt);
  const exp = Number(query.exp);
  const sig = typeof query.sig === 'string' ? query.sig : '';
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(exp) || !sig)
    throw new HttpError(403, 'bad_signature', 'the link is not signed');
  const want = Buffer.from(await mac(ctx, { ...c, attempt, exp }));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got))
    throw new HttpError(403, 'bad_signature', 'the link signature does not match');
  if (exp <= ctx.clock.now().getTime()) throw new HttpError(403, 'link_expired', 'the link has expired');
  return { attempt, exp };
}
