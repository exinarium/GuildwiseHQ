import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { powOk, solvePowHere } from '../public-form/pow.ts';
import { sha256Bytes, sha256File, toHex } from '../public-form/sha256.ts';

const enc = new TextEncoder();
const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('sha256 in the page', () => {
  it('matches the platform for empty, short, block-edge and large inputs', () => {
    for (const n of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const b = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
      expect(toHex(sha256Bytes(b))).toBe(node(b));
    }
    expect(toHex(sha256Bytes(enc.encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a File', async () => {
    const f = new File(['hello world'], 'a.txt');
    expect(await sha256File(f)).toBe(node(enc.encode('hello world')));
  });
});

describe('proof of work in the page', () => {
  it('a solved nonce satisfies the rule the server checks (leading zero bits of sha256(session:nonce))', async () => {
    const nonce = await solvePowHere('s1.session', 10);
    const h = createHash('sha256').update(`s1.session:${nonce}`).digest();
    expect(h[0]).toBe(0);
    expect((h[1] as number) >> 6).toBe(0);
    expect(powOk('s1.session', nonce, 10)).toBe(true);
    expect(powOk('s1.other', nonce, 10) && powOk('s1.other2', nonce, 10)).toBe(false);
  });

  it('zero bits needs no work', async () => {
    expect(powOk('x', 'y', 0)).toBe(true);
    expect(await solvePowHere('x', 0)).toBe('0');
  });
});
