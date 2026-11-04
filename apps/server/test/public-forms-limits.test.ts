import { describe, expect, it } from 'vitest';
import { KeyedBuckets } from '../src/public-forms/limits.ts';

describe('KeyedBuckets', () => {
  it('allows the burst, then refuses with a retry time, and refills over time', () => {
    let t = 0;
    const b = new KeyedBuckets(60, 3, () => t);
    expect(b.take('a')).toEqual({ ok: true });
    expect(b.take('a')).toEqual({ ok: true });
    expect(b.take('a')).toEqual({ ok: true });
    const refused = b.take('a');
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.retryAfterSec).toBeGreaterThanOrEqual(1);
    t += 1000; // one token per second at 60 per minute
    expect(b.take('a')).toEqual({ ok: true });
    expect(b.take('a')).toMatchObject({ ok: false });
  });

  it('keeps keys apart', () => {
    const b = new KeyedBuckets(1, 1, () => 0);
    expect(b.take('ip:1').ok).toBe(true);
    expect(b.take('ip:1').ok).toBe(false);
    expect(b.take('ip:2').ok).toBe(true);
  });

  it('never grows past its bound', () => {
    const b = new KeyedBuckets(1, 5, () => 0, 100);
    for (let i = 0; i < 1000; i++) b.take(`k${i}`);
    expect(b.size).toBeLessThanOrEqual(100);
  });
});
