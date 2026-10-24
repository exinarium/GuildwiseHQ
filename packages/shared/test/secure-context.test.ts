import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeReplyKey,
  SECURE_CONTEXT_MESSAGE,
  SecureContextError,
  sealForRunner,
  sealLarge,
  sealResealApproval,
  spkiSha256,
} from '../src/index.ts';

afterEach(() => vi.unstubAllGlobals());

/** A plain-HTTP page: `crypto` exists (getRandomValues) but `crypto.subtle` does not. */
const insecure = () =>
  vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });

describe('sealing in a page that is not a secure context', () => {
  it('sealLarge says what to do', async () => {
    insecure();
    await expect(sealLarge('AAAA', 'secret')).rejects.toThrow(SECURE_CONTEXT_MESSAGE);
  });
  it('makeReplyKey, spkiSha256 and sealResealApproval do too', async () => {
    insecure();
    await expect(makeReplyKey()).rejects.toBeInstanceOf(SecureContextError);
    await expect(spkiSha256('AAAA')).rejects.toThrow(SECURE_CONTEXT_MESSAGE);
    const t = { keyId: 'k', publicKey: 'AAAA' };
    await expect(
      sealResealApproval({
        source: t,
        target: t,
        orgId: 'o',
        provider: 'p',
        generation: 1,
        approvedBy: 'u',
      }),
    ).rejects.toThrow(SECURE_CONTEXT_MESSAGE);
  });
  it('sealForRunner does too', async () => {
    insecure();
    await expect(
      sealForRunner({
        key: { keyId: 'k', publicKey: 'AAAA' },
        serverTime: new Date().toISOString(),
        workstationId: 'w',
        ref: 'r',
        kind: 'github',
        instance: 'i',
        op: 'connect',
        fields: {},
      } as never),
    ).rejects.toThrow(SECURE_CONTEXT_MESSAGE);
  });
});
