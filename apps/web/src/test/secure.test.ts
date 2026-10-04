import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../lib/secure.ts';

// The app is served over plain HTTP on a LAN address for testing, where crypto.randomUUID does not exist
// (secure contexts only). Chat send used it and silently did nothing there.
describe('newId outside a secure context', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to getRandomValues and returns a v4 uuid', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    const ids = new Set(Array.from({ length: 50 }, () => newId()));
    expect(ids.size).toBe(50);
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('uses randomUUID when the browser has it', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-id', getRandomValues: () => undefined });
    expect(newId()).toBe('fixed-id');
  });
});
