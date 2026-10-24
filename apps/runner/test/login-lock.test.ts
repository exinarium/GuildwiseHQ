import { existsSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withFileLock } from '../src/adapters/login-lock.ts';

describe('login file lock', () => {
  it('serialises critical sections and releases the lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lk-'));
    const lock = join(dir, 'auth.json.aom-lock');
    const order: string[] = [];
    const a = withFileLock(lock, async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 60));
      order.push('a2');
    });
    const b = withFileLock(lock, () => {
      order.push('b');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a1', 'a2', 'b']);
    expect(existsSync(lock)).toBe(false);
  });
  it('breaks a stale lock and gives up waiting on a live one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lk-'));
    const lock = join(dir, 'x.aom-lock');
    mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(await withFileLock(lock, () => 'ran', { staleMs: 1000 })).toBe('ran');
    mkdirSync(lock);
    // a fresh lock held by someone else: runs after the wait, and leaves their lock alone
    expect(await withFileLock(lock, () => 'late', { waitMs: 60, pollMs: 10 })).toBe('late');
    expect(existsSync(lock)).toBe(true);
  });
});
