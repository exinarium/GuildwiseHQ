import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/context.ts';
import {
  newLinkId,
  powValid,
  signClientLink,
  signSession,
  signUpload,
  verifyClientLink,
  verifySession,
  verifyUpload,
} from '../src/public-forms/tokens.ts';

const ctxWith = (secret: string, now: () => Date): Ctx =>
  ({ config: { secretKey: secret }, clock: { now } }) as unknown as Ctx;
const clockNow = new Date('2026-11-04T10:00:00Z');
const ctx = ctxWith('test-secret-one', () => clockNow);
const FORM = '5f0b6a6e-2f0e-4c3f-9d0e-0a8d1f7a1111';
const OTHER = '5f0b6a6e-2f0e-4c3f-9d0e-0a8d1f7a2222';
const inDays = (d: number) => new Date(clockNow.getTime() + d * 86_400_000);

describe('client link token', () => {
  it('signs and verifies, and carries only a random id and an expiry', async () => {
    const id = newLinkId();
    const token = await signClientLink(ctx, FORM, id, inDays(14));
    const v = await verifyClientLink(ctx, FORM, token);
    expect(v).toMatchObject({ ok: true, linkId: id });
    expect(token.split('.')).toHaveLength(4);
    // nothing of the client can be in it: the reference is not part of the token at all
    expect(Buffer.from(token.split('.')[1] as string, 'base64url')).toHaveLength(16);
  });

  it('is bound to one form', async () => {
    const token = await signClientLink(ctx, FORM, newLinkId(), inDays(1));
    expect(await verifyClientLink(ctx, OTHER, token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a flipped byte anywhere, another key, and a malformed token', async () => {
    const token = await signClientLink(ctx, FORM, newLinkId(), inDays(1));
    const parts = token.split('.');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    for (const i of [1, 2, 3]) {
      const p = [...parts];
      p[i] = flip(p[i] as string);
      expect(await verifyClientLink(ctx, FORM, p.join('.'))).toMatchObject({ ok: false });
    }
    const otherKey = ctxWith('another-secret', () => clockNow);
    expect(await verifyClientLink(otherKey, FORM, token)).toEqual({ ok: false, reason: 'invalid' });
    for (const bad of ['', 'v1', 'x.y.z', `${token}x`, token.replace('v1', 'v2')])
      expect(await verifyClientLink(ctx, FORM, bad)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('expires by the signed time, judged by the clock', async () => {
    const token = await signClientLink(ctx, FORM, newLinkId(), inDays(1));
    expect(await verifyClientLink(ctx, FORM, token, inDays(0.9))).toMatchObject({ ok: true });
    expect(await verifyClientLink(ctx, FORM, token, inDays(1.1))).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('form session and proof of work', () => {
  it('a session verifies for its form only and carries the version', async () => {
    const s = await signSession(ctx, FORM, 3, clockNow);
    expect(await verifySession(ctx, FORM, s)).toMatchObject({ version: 3, issuedAt: clockNow.getTime() });
    expect(await verifySession(ctx, OTHER, s)).toBeNull();
    expect(await verifySession(ctx, FORM, s.replace('.3.', '.4.'))).toBeNull();
    expect(await verifySession(ctx, FORM, 'nonsense')).toBeNull();
  });

  it('every session has its own nonce (the anti-replay key)', async () => {
    const a = await verifySession(ctx, FORM, await signSession(ctx, FORM, 1, clockNow));
    const b = await verifySession(ctx, FORM, await signSession(ctx, FORM, 1, clockNow));
    expect(a?.nonce).not.toBe(b?.nonce);
  });

  it('proof of work: zero bits always passes; a found nonce passes and a wrong one does not', () => {
    expect(powValid('s', 'x', 0)).toBe(true);
    const bits = 10;
    let nonce = '';
    for (let i = 0; ; i++) {
      const h = createHash('sha256')
        .update(`sess:${i.toString(36)}`)
        .digest();
      if (h[0] === 0 && (h[1] as number) >> 6 === 0) {
        nonce = i.toString(36);
        break;
      }
    }
    expect(powValid('sess', nonce, bits)).toBe(true);
    expect(powValid('sess2', nonce, bits)).toBe(false);
    expect(powValid('sess', 'bad nonce!', bits)).toBe(false);
  });
});

describe('upload token', () => {
  const SID = '0b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11';
  it('is for one submission and expires', async () => {
    const t = await signUpload(ctx, SID, inDays(0.05));
    expect(await verifyUpload(ctx, SID, t)).toBe(true);
    expect(await verifyUpload(ctx, '1b3e7c64-5d0a-4a52-9f43-1f0f6a1d2b11', t)).toBe(false);
    expect(await verifyUpload(ctx, SID, undefined)).toBe(false);
    expect(await verifyUpload(ctx, SID, `${t}x`)).toBe(false);
    expect(await verifyUpload(ctx, SID, t, inDays(1))).toBe(false);
  });

  it('a client link token means nothing as an upload token', async () => {
    const link = await signClientLink(ctx, FORM, newLinkId(), inDays(1));
    expect(await verifyUpload(ctx, SID, link)).toBe(false);
  });
});
