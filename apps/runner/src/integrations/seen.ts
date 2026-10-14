import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Replay protection for sealed envelopes: a `ref` is accepted once. Seen refs are kept until their `exp` (so a captured
 * envelope is useless after it expired anyway), in memory and in `secrets/integration-seen.json`, so a restart does not
 * reopen the window. Holds refs and expiry times only, never a value.
 */
export class ReplayCache {
  private seen = new Map<string, number>();

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [ref, exp] of Object.entries(doc)) if (typeof exp === 'number') this.seen.set(ref, exp);
    } catch {
      // no file yet
    }
    this.prune();
  }

  private prune(): void {
    const t = this.now();
    for (const [ref, exp] of this.seen) if (exp <= t) this.seen.delete(ref);
  }

  /** Records `ref` and returns true, or returns false when it was seen before (a replay). */
  claim(ref: string, exp: number): boolean {
    this.prune();
    if (this.seen.has(ref)) return false;
    this.seen.set(ref, exp);
    this.save();
    return true;
  }

  has(ref: string): boolean {
    this.prune();
    return this.seen.has(ref);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.seen)), { mode: 0o600 });
      renameSync(tmp, this.file);
      try {
        chmodSync(this.file, 0o600);
      } catch {
        // Windows
      }
    } catch {
      // the in-memory set still protects this process
    }
  }
}
