import { createHmac, randomBytes } from 'node:crypto';
import type { Ctx } from '../context.ts';

interface Bucket {
  tokens: number;
  at: number;
}

/**
 * Token buckets by key, per process. The maths of the webhook relay's bucket: `perMinute` refills continuously up to
 * `burst`. The map is bounded (50 000 keys): when full, buckets that have refilled completely are dropped first.
 */
export class KeyedBuckets {
  private readonly map = new Map<string, Bucket>();
  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Takes one token; `retryAfterSec` says when the next one is available. */
  take(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    const t = this.now();
    const b = this.map.get(key) ?? { tokens: this.burst, at: t };
    const refill = ((t - b.at) / 60_000) * this.perMinute;
    b.tokens = Math.min(this.burst, b.tokens + refill);
    b.at = t;
    if (b.tokens < 1) {
      this.map.set(key, b);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((1 - b.tokens) / this.perMinute) * 60)) };
    }
    b.tokens -= 1;
    if (!this.map.has(key) && this.map.size >= this.maxKeys) this.sweep(t);
    this.map.set(key, b);
    return { ok: true };
  }

  get size(): number {
    return this.map.size;
  }

  private sweep(t: number): void {
    for (const [k, b] of this.map) {
      if (b.tokens + ((t - b.at) / 60_000) * this.perMinute >= this.burst) this.map.delete(k);
    }
    // still full of active keys: make room by dropping the oldest entries
    for (const k of this.map.keys()) {
      if (this.map.size < this.maxKeys) break;
      this.map.delete(k);
    }
  }
}

const PROCESS_KEY = randomBytes(32);

/** The address of a client, salted and hashed: only ever a counter key, never stored or logged. */
export function clientKey(ctx: Ctx, ip: string): string {
  const secret = ctx.config.secretKey ? Buffer.from(ctx.config.secretKey) : PROCESS_KEY;
  return createHmac('sha256', secret).update(`form-ip|${ip}`).digest('hex').slice(0, 24);
}

export interface FormLimits {
  /** Every public form request. */
  ip: KeyedBuckets;
  /** Submission starts per client address. */
  ipSubmit: KeyedBuckets;
  /** Submission starts per form. */
  formSubmit: KeyedBuckets;
}

export function createFormLimits(ctx: Ctx, now: () => number = () => ctx.clock.now().getTime()): FormLimits {
  const c = ctx.config.publicForms;
  return {
    ip: new KeyedBuckets(c.ipPerMin, c.ipBurst, now),
    ipSubmit: new KeyedBuckets(c.ipSubmitsPerHour / 60, c.ipSubmitBurst, now),
    formSubmit: new KeyedBuckets(c.formSubmitsPerMin, c.formSubmitBurst, now),
  };
}
