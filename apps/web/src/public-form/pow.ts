import { openFormWorker, type WorkerReply, type WorkerRequest } from './form-worker.ts';
import { sha256Bytes, toHex, yieldToEventLoop } from './sha256.ts';

/** Neither the worker nor the page itself can solve the proof of work in this browser. */
export class PowUnsupportedError extends Error {
  constructor() {
    super('The proof of work cannot run in this browser.');
    this.name = 'PowUnsupportedError';
  }
}

let encoder: TextEncoder | undefined;
const encode = (s: string): Uint8Array => {
  encoder ??= new TextEncoder();
  return encoder.encode(s);
};

/** True when `sha256(session + ':' + nonce)` starts with `bits` zero bits (the server checks the same). */
export function powOk(session: string, nonce: string, bits: number): boolean {
  if (bits <= 0) return true;
  const h = sha256Bytes(encode(`${session}:${nonce}`));
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

const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/** One known hash before solving: a browser that computes it wrong (or cannot at all) gets the clear message instead. */
export function selfTest(): void {
  let hex = '';
  try {
    hex = toHex(sha256Bytes(encode('abc')));
  } catch {
    throw new PowUnsupportedError();
  }
  if (hex !== ABC) throw new PowUnsupportedError();
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Finds a nonce on the page itself (the fallback when no worker can run). It works for about `budgetMs` at a time and
 * then yields, so typing stays smooth on a slow device too.
 */
export async function solvePowHere(session: string, bits: number, budgetMs = 8): Promise<string> {
  if (bits <= 0) return '0';
  selfTest();
  for (let i = 0; ; ) {
    const until = now() + budgetMs;
    do {
      // a few hashes between clock reads
      for (const end = i + 64; i < end; i++) {
        const nonce = i.toString(36);
        if (powOk(session, nonce, bits)) return nonce;
      }
    } while (now() < until);
    await yieldToEventLoop();
  }
}

/**
 * Solves in a worker (same-origin script) while the person types; falls back to the page itself. Rejects with
 * PowUnsupportedError only when both fail.
 */
export function solvePow(session: string, bits: number): Promise<string> {
  if (bits <= 0) return Promise.resolve('0');
  return new Promise((resolve, reject) => {
    const here = () =>
      solvePowHere(session, bits).then(resolve, (e: unknown) =>
        reject(e instanceof PowUnsupportedError ? e : new PowUnsupportedError()),
      );
    let w: Worker;
    try {
      w = openFormWorker();
    } catch {
      void here();
      return;
    }
    w.onmessage = (e: MessageEvent<WorkerReply | string>) => {
      w.terminate();
      const d = e.data;
      if (typeof d === 'string') resolve(d);
      else if (d?.kind === 'pow') resolve(d.nonce);
      else void here();
    };
    w.onerror = () => {
      w.terminate();
      void here();
    };
    w.postMessage({ kind: 'pow', session, bits } satisfies WorkerRequest);
  });
}
