import { sha256Bytes } from './sha256.ts';

const enc = new TextEncoder();

/** True when `sha256(session + ':' + nonce)` starts with `bits` zero bits (the server checks the same). */
export function powOk(session: string, nonce: string, bits: number): boolean {
  if (bits <= 0) return true;
  const h = sha256Bytes(enc.encode(`${session}:${nonce}`));
  let left = bits;
  for (const byte of h) {
    if (left <= 0) return true;
    if (left >= 8) {
      if (byte !== 0) return false;
      left -= 8;
    } else return byte >> (8 - left) === 0;
  }
  return left <= 0;
}

/** Finds a nonce, a slice at a time so the page stays responsive (the fallback when no worker can run). */
export async function solvePowHere(session: string, bits: number, slice = 2000): Promise<string> {
  if (bits <= 0) return '0';
  for (let n = 0; ; n += slice) {
    for (let i = n; i < n + slice; i++) {
      const nonce = i.toString(36);
      if (powOk(session, nonce, bits)) return nonce;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Solves in a worker (same-origin script) while the person types; falls back to the page itself. */
export function solvePow(session: string, bits: number): Promise<string> {
  if (bits <= 0) return Promise.resolve('0');
  return new Promise((resolve) => {
    try {
      const w = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<string>) => {
        w.terminate();
        resolve(e.data);
      };
      w.onerror = () => {
        w.terminate();
        void solvePowHere(session, bits).then(resolve);
      };
      w.postMessage({ session, bits });
    } catch {
      void solvePowHere(session, bits).then(resolve);
    }
  });
}
