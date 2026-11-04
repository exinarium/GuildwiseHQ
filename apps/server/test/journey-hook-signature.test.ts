import { describe, expect, it } from 'vitest';
import { signHook, verifyHookSignature } from '../src/journeys/hooks/signature.ts';

const secret = 'jhsec_test';
const raw = Buffer.from('{"id":"1"}');
const now = 1_800_000_000;

describe('inbound hook signature', () => {
  it('accepts the guildwise scheme within the tolerance', () => {
    const h = signHook('guildwise', secret, raw, now);
    expect(verifyHookSignature('guildwise', secret, h, raw, now)).toBe('ok');
    expect(verifyHookSignature('guildwise', secret, h, raw, now + 299)).toBe('ok');
  });
  it('refuses a stale timestamp, a different body, a different secret', () => {
    const h = signHook('guildwise', secret, raw, now);
    expect(verifyHookSignature('guildwise', secret, h, raw, now + 301)).toBe('stale');
    expect(verifyHookSignature('guildwise', secret, h, Buffer.from('{"id":"2"}'), now)).toBe('bad');
    expect(verifyHookSignature('guildwise', 'other', h, raw, now)).toBe('bad');
  });
  it('a signature of the wrong length or not hex never throws', () => {
    expect(
      verifyHookSignature(
        'guildwise',
        secret,
        { 'x-guildwise-signature': 'sha256=abcd', 'x-guildwise-timestamp': String(now) },
        raw,
        now,
      ),
    ).toBe('missing');
    expect(
      verifyHookSignature(
        'guildwise',
        secret,
        { 'x-guildwise-signature': `sha256=${'z'.repeat(64)}`, 'x-guildwise-timestamp': String(now) },
        raw,
        now,
      ),
    ).toBe('missing');
    expect(
      verifyHookSignature(
        'guildwise',
        secret,
        { 'x-guildwise-signature': `sha256=${'0'.repeat(64)}`, 'x-guildwise-timestamp': 'abc' },
        raw,
        now,
      ),
    ).toBe('bad');
  });
  it('requires both headers', () => {
    expect(verifyHookSignature('guildwise', secret, {}, raw, now)).toBe('missing');
    const h = signHook('guildwise', secret, raw, now);
    expect(
      verifyHookSignature(
        'guildwise',
        secret,
        { 'x-guildwise-signature': h['x-guildwise-signature'] },
        raw,
        now,
      ),
    ).toBe('missing');
  });
  it('body_sha256 signs the body only and accepts either header name', () => {
    const h = signHook('body_sha256', secret, raw, now);
    expect(verifyHookSignature('body_sha256', secret, h, raw, now + 99_999)).toBe('ok');
    expect(
      verifyHookSignature('body_sha256', secret, { 'x-signature': h['x-hub-signature-256'] }, raw, now),
    ).toBe('ok');
    expect(verifyHookSignature('body_sha256', secret, h, Buffer.from('x'), now)).toBe('bad');
    expect(verifyHookSignature('body_sha256', secret, {}, raw, now)).toBe('missing');
  });
});
