/** What the page asks the form's worker to do. */
export type WorkerRequest = { kind: 'pow'; session: string; bits: number } | { kind: 'file'; file: Blob };

/** What the worker answers; `error` when it could not do the work at all. */
export type WorkerReply =
  | { kind: 'pow'; nonce: string }
  | { kind: 'file'; hex: string }
  | { kind: 'error'; code: 'unsupported' };

/** The public form's one worker (proof of work and file hashing). Throws when this browser cannot start it. */
export const openFormWorker = (): Worker =>
  new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' });
