import { HttpError } from '../errors.ts';

/**
 * Small in-memory sliding-window counter for limits the route-level plugin cannot express (a second key on the same
 * route, a key only known after authentication). Per process, like the plugin's default store.
 */
export class SlidingLimit {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt; throws 429 once `max` attempts happened within the window. */
  hit(key: string): void {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      throw new HttpError(429, 'rate_limited', 'too many attempts; try again in a minute');
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((x) => t - x >= this.windowMs)) this.hits.delete(k);
    }
  }
}
