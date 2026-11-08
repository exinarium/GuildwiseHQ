import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRequest } from '../public-form/form-worker.ts';
import { powOk, selfTest, solvePow, solvePowHere } from '../public-form/pow.ts';
import {
  fileDigestPath,
  nativeSubtle,
  Sha256,
  sha256Bytes,
  sha256Chunks,
  sha256File,
  sha256FileHere,
  toHex,
} from '../public-form/sha256.ts';

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

// ---- Pages without crypto.subtle (plain http on a LAN or self-hosted address) ----

const realCrypto = globalThis.crypto;
const realSubtle = realCrypto.subtle;
/** As on a page that is not a secure context: crypto is there, its subtle is not. */
const withoutSubtle = (subtle: unknown = undefined) =>
  vi.stubGlobal('crypto', {
    getRandomValues: <T extends ArrayBufferView>(a: T) => realCrypto.getRandomValues(a as never) as T,
    subtle,
  });

/** The server's default difficulty (AOM_FORMS_POW_BITS in apps/server/src/config.ts). */
const PRODUCTION_POW_BITS = 16;
/** The server's check (powValid in apps/server/src/public-forms/tokens.ts), recomputed with node:crypto. */
const serverPowValid = (session: string, nonce: string, bits: number): boolean => {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(nonce)) return false;
  const h = createHash('sha256').update(`${session}:${nonce}`).digest();
  let left = bits;
  for (const byte of h) {
    if (left <= 0) return true;
    if (left >= 8) {
      if (byte !== 0) return false;
      left -= 8;
    } else return byte >> (8 - left) === 0;
  }
  return left <= 0;
};

/** A stand-in for the form's worker: runs the same code as pow.worker.ts, or fails in the way asked. */
const fakeWorker = (mode: 'work' | 'error-reply' | 'onerror' | 'throws') => {
  const created: unknown[] = [];
  class FakeWorker {
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    terminated = false;
    constructor() {
      if (mode === 'throws') throw new Error('no workers here');
      created.push(this);
    }
    postMessage(req: WorkerRequest) {
      void (async () => {
        if (mode === 'onerror') return this.onerror?.(new Event('error'));
        if (mode === 'error-reply')
          return this.onmessage?.({ data: { kind: 'error', code: 'unsupported' } } as MessageEvent);
        const data =
          req.kind === 'file'
            ? { kind: 'file', hex: await sha256Chunks(req.file) }
            : { kind: 'pow', nonce: await solvePowHere(req.session, req.bits) };
        this.onmessage?.({ data } as MessageEvent);
      })();
    }
    terminate() {
      this.terminated = true;
    }
  }
  vi.stubGlobal('Worker', FakeWorker);
  return created;
};

afterEach(() => vi.unstubAllGlobals());

const NIST: Array<[string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
];

/** Feeds `data` to the incremental hasher in pieces of the given sizes (cycled). */
const inPieces = (data: Uint8Array, sizes: number[]): string => {
  const h = new Sha256();
  for (let off = 0, k = 0; off < data.length; k++) {
    const n = sizes[k % sizes.length] as number;
    h.update(data.subarray(off, off + n));
    off += n;
  }
  return toHex(h.digest());
};

describe('the JavaScript SHA-256 gives the same bytes as the platform', () => {
  it.each(NIST)('NIST vector %j, whole and in uneven pieces', (text, hex) => {
    const b = enc.encode(text);
    expect(toHex(sha256Bytes(b))).toBe(hex);
    for (const sizes of [[1], [63], [64], [65], [1, 63, 64, 65], [b.length || 1]])
      expect(inPieces(b, sizes)).toBe(hex);
    // an empty update changes nothing
    expect(toHex(new Sha256().update(new Uint8Array(0)).update(b).update(new Uint8Array(0)).digest())).toBe(
      hex,
    );
  });

  it('a 1 MiB random buffer equals node:crypto and crypto.subtle', async () => {
    const b = new Uint8Array(1 << 20);
    for (let off = 0; off < b.length; off += 65536) realCrypto.getRandomValues(b.subarray(off, off + 65536));
    const subtle = toHex(new Uint8Array(await realSubtle.digest('SHA-256', b)));
    expect(toHex(sha256Bytes(b))).toBe(node(b));
    expect(toHex(sha256Bytes(b))).toBe(subtle);
    expect(inPieces(b, [1000, 7, 64 * 1024 + 3])).toBe(subtle);
  });

  it('works on a view into a larger buffer (offset not on a block edge)', () => {
    const big = new Uint8Array(300).map((_, i) => i & 0xff);
    const view = big.subarray(5, 250);
    expect(toHex(sha256Bytes(view))).toBe(node(view));
  });

  it('the digest can be taken only once', () => {
    const h = new Sha256().update(enc.encode('abc'));
    h.digest();
    expect(() => h.digest()).toThrow();
    expect(() => h.update(enc.encode('x'))).toThrow();
  });
});

describe('choosing the file digest by feature', () => {
  it('uses the browser digest when crypto.subtle.digest is there (https, localhost)', () => {
    expect(nativeSubtle()).toBe(realSubtle);
    expect(fileDigestPath()).toBe('subtle');
  });

  it('uses JavaScript when crypto.subtle is missing', () => {
    withoutSubtle();
    expect(nativeSubtle()).toBeNull();
    expect(fileDigestPath()).toBe('js');
  });

  it('uses JavaScript when crypto.subtle has no digest function', () => {
    withoutSubtle({});
    expect(fileDigestPath()).toBe('js');
  });

  it('uses JavaScript when there is no crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(fileDigestPath()).toBe('js');
  });

  it('sha256File calls crypto.subtle.digest when it is there', async () => {
    const digest = vi.fn((alg: string, data: BufferSource) => realSubtle.digest(alg, data));
    withoutSubtle({ digest });
    const f = new File(['hello world'], 'a.txt');
    expect(await sha256File(f)).toBe(node(enc.encode('hello world')));
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it('sha256File does not touch crypto.subtle when it is missing, and still gives the same hash', async () => {
    const subtleGet = vi.fn(() => undefined);
    vi.stubGlobal('crypto', Object.defineProperty({}, 'subtle', { get: subtleGet }));
    const f = new File(['hello world'], 'a.txt');
    expect(await sha256File(f)).toBe(node(enc.encode('hello world')));
  });

  it('sha256File falls back to JavaScript when the browser digest throws', async () => {
    withoutSubtle({ digest: vi.fn(async () => Promise.reject(new Error('nope'))) });
    expect(await sha256File(new File(['abc'], 'a.txt'))).toBe(NIST[1]?.[1]);
  });
});

describe('hashing a file without crypto.subtle', () => {
  const blob = () => {
    const b = new Uint8Array(3.5 * (1 << 20)).map((_, i) => (i * 7 + (i >> 9)) & 0xff);
    return { bytes: b, file: new Blob([b]) };
  };

  it('a multi-chunk file equals the one-shot digest, on the page and with an odd chunk size', async () => {
    withoutSubtle();
    const { bytes, file } = blob();
    const want = node(bytes);
    expect(await sha256File(file)).toBe(want); // no Worker in this environment: the page path
    expect(await sha256FileHere(file)).toBe(want);
    expect(await sha256FileHere(file.slice(0, 10_000), 1000)).toBe(node(bytes.subarray(0, 10_000)));
    expect(await sha256FileHere(file.slice(0, 9_999), 1000)).toBe(node(bytes.subarray(0, 9_999)));
    expect(await sha256FileHere(new Blob([]))).toBe(NIST[0]?.[1]);
  });

  it('the page yields between chunks', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await sha256FileHere(new Blob([new Uint8Array(5000)]), 1000);
    expect(spy.mock.calls.filter(([, ms]) => ms === 0).length).toBeGreaterThanOrEqual(5);
    spy.mockRestore();
  });

  it('hashes in the worker when one can run', async () => {
    withoutSubtle();
    const workers = fakeWorker('work');
    const { bytes, file } = blob();
    expect(await sha256File(file)).toBe(node(bytes));
    expect(workers).toHaveLength(1);
    expect((workers[0] as { terminated: boolean }).terminated).toBe(true);
  });

  it.each(['error-reply', 'onerror', 'throws'] as const)(
    'falls back to the page when the worker %s, with the same result',
    async (mode) => {
      withoutSubtle();
      fakeWorker(mode);
      const { bytes, file } = blob();
      expect(await sha256File(file)).toBe(node(bytes));
    },
  );
});

describe('the proof of work without crypto.subtle', () => {
  const SESSION = 's1.AAAAAAAAAAAAAAAA.abc.1.sig';

  it('solvePow returns a nonce the server accepts at the production difficulty', async () => {
    withoutSubtle();
    const nonce = await solvePow(SESSION, PRODUCTION_POW_BITS);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    expect(serverPowValid(SESSION, nonce, PRODUCTION_POW_BITS)).toBe(true);
    vi.unstubAllGlobals();
    // the same nonce with crypto.subtle present: the solver does not change path on https or localhost
    expect(await solvePow(SESSION, PRODUCTION_POW_BITS)).toBe(nonce);
  });

  it('solvePow uses the worker when one can run, and the page when the worker fails', async () => {
    withoutSubtle();
    const workers = fakeWorker('work');
    const n1 = await solvePow(SESSION, 10);
    expect(workers).toHaveLength(1);
    expect(serverPowValid(SESSION, n1, 10)).toBe(true);
    for (const mode of ['error-reply', 'onerror', 'throws'] as const) {
      fakeWorker(mode);
      expect(await solvePow(SESSION, 10)).toBe(n1);
    }
  });

  it('the page solver yields to the event loop', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await solvePowHere(SESSION, 14, 1);
    expect(spy.mock.calls.some(([, ms]) => ms === 0)).toBe(true);
    spy.mockRestore();
  });

  it('the self-test passes on a working engine', () => {
    expect(() => selfTest()).not.toThrow();
  });

  it('solvePow rejects with PowUnsupportedError only when the worker and the page both fail', async () => {
    fakeWorker('throws');
    vi.stubGlobal(
      'TextEncoder',
      class {
        constructor() {
          throw new TypeError('TextEncoder is not available');
        }
      },
    );
    vi.resetModules();
    const pow = await import('../public-form/pow.ts');
    await expect(pow.solvePow(SESSION, 8)).rejects.toBeInstanceOf(pow.PowUnsupportedError);
    await expect(pow.solvePowHere(SESSION, 8)).rejects.toBeInstanceOf(pow.PowUnsupportedError);
  });
});
