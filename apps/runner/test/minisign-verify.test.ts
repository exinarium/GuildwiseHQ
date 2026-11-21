import { describe, expect, it } from 'vitest';
import { minisigKeyId, publicKeyLine, verifyMinisign } from '../src/update/minisign.ts';
import { fixture, minisignSign, OTHER_PUB, TEST_KEY_ID, TEST_PUB } from './minisign-helper.ts';

describe('minisign verification with node:crypto (R18-U)', () => {
  it('verifies the W0 fixture manifest signed by the real minisign binary', () => {
    const r = verifyMinisign(fixture('manifest.json'), fixture('manifest.json.minisig'), TEST_PUB);
    expect(r).toMatchObject({ ok: true, keyId: TEST_KEY_ID, trustedComment: 'guildwise-runner 1.10.0' });
  });

  it('refuses a signature by another key', () => {
    const r = verifyMinisign(fixture('manifest.json'), fixture('manifest.json.other.minisig'), TEST_PUB);
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(/not by the trusted key/);
  });

  it('refuses a tampered message and a tampered trusted comment', () => {
    const text = fixture('manifest.json');
    const sig = fixture('manifest.json.minisig');
    expect(verifyMinisign(text.replace('1.10.0', '1.10.1'), sig, TEST_PUB).ok).toBe(false);
    expect(
      verifyMinisign(text, sig.replace('guildwise-runner 1.10.0', 'guildwise-runner 9.9.9'), TEST_PUB).ok,
    ).toBe(false);
  });

  it('accepts legacy (Ed) and prehashed (ED) signatures; refuses the placeholder key and garbage', () => {
    expect(verifyMinisign('hello', minisignSign('hello', 'test.key', 'x', false), TEST_PUB).ok).toBe(true);
    expect(verifyMinisign('hello', minisignSign('hello'), TEST_PUB).ok).toBe(true);
    expect(verifyMinisign('hello', minisignSign('hello'), 'PLACEHOLDER')).toMatchObject({ ok: false });
    expect(verifyMinisign('hello', 'nonsense', TEST_PUB).ok).toBe(false);
    expect(verifyMinisign('hello', minisignSign('hello', 'other.key'), OTHER_PUB).ok).toBe(true);
  });

  it('reads key lines and key ids', () => {
    expect(publicKeyLine(TEST_PUB)).toMatch(/^RW/);
    expect(minisigKeyId(fixture('manifest.json.minisig'))).toBe(TEST_KEY_ID);
  });
});
