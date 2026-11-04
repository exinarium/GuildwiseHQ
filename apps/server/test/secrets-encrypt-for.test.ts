import { describe, expect, it } from 'vitest';
import { decryptFor, encryptFor } from '../src/auth/secrets.ts';
import type { Ctx } from '../src/context.ts';

/** `encryptFor` / `decryptFor` (GWP-68): a purpose key and an authenticated id. Only `config.secretKey` is read. */
const ctxWith = (secretKey: string) => ({ config: { secretKey } }) as unknown as Ctx;

describe('encryptFor / decryptFor', () => {
  it('round-trips and is random per call', async () => {
    const ctx = ctxWith('server-secret-1');
    const a = await encryptFor(ctx, 'form-offline-contact', 'case-1', 'ann@client.example');
    const b = await encryptFor(ctx, 'form-offline-contact', 'case-1', 'ann@client.example');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain('ann@client.example');
    expect(await decryptFor(ctx, 'form-offline-contact', 'case-1', a)).toBe('ann@client.example');
  });

  it('does not open under another row id (the id is authenticated)', async () => {
    const ctx = ctxWith('server-secret-1');
    const blob = await encryptFor(ctx, 'form-offline-contact', 'case-1', 'x@y.example');
    await expect(decryptFor(ctx, 'form-offline-contact', 'case-2', blob)).rejects.toThrow();
  });

  it('does not open under another purpose', async () => {
    const ctx = ctxWith('server-secret-1');
    const blob = await encryptFor(ctx, 'form-offline-contact', 'case-1', 'x@y.example');
    await expect(decryptFor(ctx, 'something-else', 'case-1', blob)).rejects.toThrow();
  });

  it('does not open after the server key changed, and refuses a tampered blob', async () => {
    const blob = await encryptFor(ctxWith('server-secret-1'), 'p', 'id', 'x@y.example');
    await expect(decryptFor(ctxWith('server-secret-2'), 'p', 'id', blob)).rejects.toThrow();
    const parts = blob.split(':');
    parts[3] = Buffer.from('tampered').toString('base64url');
    await expect(decryptFor(ctxWith('server-secret-1'), 'p', 'id', parts.join(':'))).rejects.toThrow();
    await expect(decryptFor(ctxWith('server-secret-1'), 'p', 'id', 'nope')).rejects.toThrow();
  });
});
