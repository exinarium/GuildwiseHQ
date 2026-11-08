import { openFormWorker, type WorkerReply, type WorkerRequest } from './form-worker.ts';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/**
 * SHA-256 in plain JavaScript, fed a piece at a time: synchronous and independent of `crypto.subtle`, which a page served
 * over plain HTTP does not have. Used for the proof of work (many small hashes) and to hash a file in chunks when the
 * browser offers no digest of its own.
 */
export class Sha256 {
  private readonly h = new Uint32Array(IV);
  private readonly w = new Uint32Array(64);
  private readonly buf = new Uint8Array(64);
  private readonly bufView = new DataView(this.buf.buffer);
  private bufLen = 0;
  /** Bytes fed so far. */
  private total = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('The digest was already taken.');
    this.total += data.length;
    let pos = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      pos = take;
      if (this.bufLen < 64) return this;
      this.compress(this.bufView, 0);
      this.bufLen = 0;
    }
    if (data.length - pos >= 64) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (; pos + 64 <= data.length; pos += 64) this.compress(view, pos);
    }
    if (pos < data.length) {
      this.buf.set(data.subarray(pos), 0);
      this.bufLen = data.length - pos;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error('The digest was already taken.');
    this.finished = true;
    const bits = this.total * 8;
    const buf = this.buf;
    buf[this.bufLen++] = 0x80;
    if (this.bufLen > 56) {
      buf.fill(0, this.bufLen);
      this.compress(this.bufView, 0);
      this.bufLen = 0;
    }
    buf.fill(0, this.bufLen, 56);
    this.bufView.setUint32(56, Math.floor(bits / 0x100000000));
    this.bufView.setUint32(60, bits >>> 0);
    this.compress(this.bufView, 0);
    const h = this.h;
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i] as number);
    return out;
  }

  /** One 64-byte block at `off`. */
  private compress(view: DataView, off: number): void {
    const h = this.h;
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number;
      const b = w[i - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0;
    h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0;
    h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0;
    h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0;
    h[7] = ((h[7] as number) + hh) | 0;
  }
}

/** SHA-256 of a whole buffer in plain JavaScript. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Sha256().update(data).digest();
}

export const toHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Lets the browser handle input and paint before the next piece of work. */
export const yieldToEventLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * The browser's own digest when this page has one (https, localhost), else null (a page over plain http). Decided by
 * testing for the feature only, never by the address of the page.
 */
export function nativeSubtle(): SubtleCrypto | null {
  const s = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  return s && typeof s.digest === 'function' ? s : null;
}

export type DigestPath = 'subtle' | 'js';
/** Which implementation hashes a file here: the browser's (fast, one shot) or the JavaScript one (chunked). */
export const fileDigestPath = (): DigestPath => (nativeSubtle() ? 'subtle' : 'js');

/** Chunk size for hashing a file in JavaScript: only this much of the file is in memory at once. */
export const FILE_CHUNK = 1 << 20;

/** Hashes a file in chunks with the JavaScript implementation; `pause` runs between chunks (the page yields there). */
export async function sha256Chunks(
  file: Blob,
  chunk = FILE_CHUNK,
  pause?: () => Promise<void>,
): Promise<string> {
  const h = new Sha256();
  for (let off = 0; off < file.size; off += chunk) {
    h.update(new Uint8Array(await file.slice(off, off + chunk).arrayBuffer()));
    if (pause) await pause();
  }
  return toHex(h.digest());
}

/** On the page itself, a chunk at a time, yielding between chunks so typing stays smooth. */
export const sha256FileHere = (file: Blob, chunk = FILE_CHUNK): Promise<string> =>
  sha256Chunks(file, chunk, yieldToEventLoop);

/** In the form's worker. Rejects when no worker can run or the worker fails. */
export function hashFileInWorker(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = openFormWorker();
    } catch (e) {
      reject(e);
      return;
    }
    w.onmessage = (e: MessageEvent<WorkerReply>) => {
      w.terminate();
      if (e.data?.kind === 'file') resolve(e.data.hex);
      else reject(new Error('The file could not be checked.'));
    };
    w.onerror = () => {
      w.terminate();
      reject(new Error('The file could not be checked.'));
    };
    w.postMessage({ kind: 'file', file } satisfies WorkerRequest);
  });
}

/**
 * Hex SHA-256 of a file: the browser's implementation when the page has one, else the JavaScript one, in the worker
 * when one can run and on the page in chunks otherwise.
 */
export async function sha256File(file: Blob): Promise<string> {
  const subtle = nativeSubtle();
  if (subtle) {
    try {
      return toHex(new Uint8Array(await subtle.digest('SHA-256', await file.arrayBuffer())));
    } catch {
      // fall through to the JavaScript implementation
    }
  }
  return hashFileInWorker(file).catch(() => sha256FileHere(file));
}
