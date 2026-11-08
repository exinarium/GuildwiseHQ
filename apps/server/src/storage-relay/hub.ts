import { createHash, randomUUID } from 'node:crypto';
import {
  renderStoragePath,
  STORAGE_CHUNK_BYTES,
  STORAGE_WINDOW,
  type StorageErrorCode,
  type StorageKind,
  type StorageReference,
  StorageReferenceSchema,
  type StorageWriteError,
  storageError,
} from '@aom/shared';

export interface StorageWriteRequest {
  orgId: string;
  connectionId: string;
  folder: string;
  name: string;
  vars: Record<string, string>;
  ext?: string;
  contentType: string;
  /** The declared size of the file. */
  size: number;
  /** The public request stream. Never buffered whole: at most one credit window is held. */
  source: AsyncIterable<Buffer>;
  /** The public client went away. */
  signal?: AbortSignal;
  /** Set on every write of a public form submission: lets the runner group the writes and roll them back. */
  submission?: { orgId: string; formId: string; submissionId: string };
  /** Set on a public form file answer: the runner scans it when the workstation's upload scan is on. */
  scan?: { field: string; fileName: string };
  /** Set only on the answers HTML: the runner also writes a PDF copy made from it. */
  derive?: { pdf: true };
}

export type StorageDerived = {
  pdf:
    | { ok: true; reference: StorageReference }
    | { ok: false; code: 'pdf_unavailable' | 'pdf_failed' | 'pdf_timeout' | 'pdf_write_failed' };
};

export type StorageWriteResult =
  | { ok: true; reference: StorageReference; derived?: StorageDerived }
  | { ok: false; error: StorageWriteError };

export interface StorageRelayDeps {
  config: { writeTimeoutMs: number; maxFileBytes: number; maxInFlight: number };
  /** The active connection of this org, or undefined. */
  lookup(
    orgId: string,
    connectionId: string,
  ): Promise<{ kind: StorageKind; workstationId: string } | undefined>;
  isOnline(workstationId: string): boolean;
  /** Sends one frame; false when there is no open socket. */
  send(workstationId: string, type: string, payload: Record<string, unknown>): boolean;
  /** Records the outcome on the connection's health row (the only thing written). */
  onOutcome(
    connectionId: string,
    outcome: { ok: true } | { ok: false; error: StorageWriteError },
  ): Promise<void> | void;
  /** One log line: `{ storage: { connectionId, kind, sizeBytes, outcome, latencyMs } }`. */
  log(entry: {
    connectionId: string;
    kind: StorageKind | null;
    sizeBytes: number;
    outcome: string;
    latencyMs: number;
  }): void;
  now?: () => number;
}

interface Pending {
  workstationId: string;
  onCredit(upTo: number): void;
  onResult(r: StorageWriteResult): void;
  onGone(): void;
}

/**
 * The write relay to a firm's storage (docs/investigations/GWP-63 section 4.4). A public upload is read as a stream and
 * forwarded in 256 KiB chunks to the one workstation that holds the connection, under a credit window, with one deadline.
 * Nothing is persisted: memory holds at most one window per transfer, and no table gets a row except the health of the
 * connection.
 */
export class StorageRelay {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;

  constructor(private readonly deps: StorageRelayDeps) {
    this.now = deps.now ?? Date.now;
  }

  get inFlight(): number {
    return this.pending.size;
  }

  async write(req: StorageWriteRequest): Promise<StorageWriteResult> {
    const start = this.now();
    let kind: StorageKind | null = null;
    const finish = async (r0: StorageWriteResult): Promise<StorageWriteResult> => {
      let r = r0;
      // A PDF receipt for another storage, or of another type, is a failed PDF: the write itself stays ok.
      if (r.ok && r.derived?.pdf.ok) {
        const ref = r.derived.pdf.reference;
        if (ref.connectionId !== req.connectionId || ref.contentType !== 'application/pdf')
          r = { ...r, derived: { pdf: { ok: false, code: 'pdf_failed' } } };
      }
      this.deps.log({
        connectionId: req.connectionId,
        kind,
        sizeBytes: req.size,
        outcome: r.ok ? 'ok' : r.error.code,
        latencyMs: this.now() - start,
      });
      if (kind)
        await this.deps.onOutcome(req.connectionId, r.ok ? { ok: true } : { ok: false, error: r.error });
      return r;
    };
    const fail = (code: StorageErrorCode, message: string) =>
      finish({ ok: false, error: storageError(code, message) });

    const conn = await this.deps.lookup(req.orgId, req.connectionId);
    if (!conn) return fail('not_found', 'This storage connection does not exist.');
    kind = conn.kind;
    const rendered = renderStoragePath({ folder: req.folder, name: req.name }, req.vars, req.ext);
    if (!rendered.ok) return fail('invalid', rendered.error);
    if (!Number.isInteger(req.size) || req.size < 0) return fail('invalid', 'The file size is not valid.');
    if (req.size > this.deps.config.maxFileBytes) return fail('too_large', 'The file is too large.');
    if (this.pending.size >= this.deps.config.maxInFlight)
      return fail('unavailable', 'Too many uploads are running: try again in a moment.');
    if (!this.deps.isOnline(conn.workstationId))
      return fail('runner_offline', "The firm's workstation is offline, so the file cannot be stored now.");

    const transferId = randomUUID();
    const deadline = start + this.deps.config.writeTimeoutMs;
    let upTo = 0;
    let wake: (() => void) | null = null;
    let outcome: StorageWriteResult | null = null;
    const settle = (r: StorageWriteResult) => {
      if (!outcome) outcome = r;
      wake?.();
    };
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(0, ms));
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    this.pending.set(transferId, {
      workstationId: conn.workstationId,
      onCredit: (n) => {
        upTo = Math.max(upTo, n);
        wake?.();
      },
      onResult: (r) => settle(r),
      onGone: () =>
        settle({
          ok: false,
          error: storageError('unavailable', 'The workstation disconnected during the upload.'),
        }),
    });
    const send = (type: string, payload: Record<string, unknown>) =>
      this.deps.send(conn.workstationId, type, { transferId, ...payload });
    const abort = (reason: 'timeout' | 'client_gone' | 'too_large' | 'shutdown') =>
      send('storage.write.abort', { reason });
    const onClientGone = () =>
      settle({ ok: false, error: storageError('unavailable', 'The upload was interrupted.') });
    req.signal?.addEventListener('abort', onClientGone, { once: true });

    try {
      const opened = send('storage.write.open', {
        connectionId: req.connectionId,
        folder: req.folder,
        name: req.name,
        vars: req.vars,
        ...(req.ext ? { ext: req.ext } : {}),
        contentType: req.contentType,
        size: req.size,
        deadlineMs: this.deps.config.writeTimeoutMs,
        ...(req.submission ? { submission: req.submission } : {}),
        ...(req.scan ? { scan: req.scan } : {}),
        ...(req.derive ? { derive: req.derive } : {}),
      });
      if (!opened)
        return await fail(
          'runner_offline',
          "The firm's workstation is offline, so the file cannot be stored now.",
        );
      // The first credit means "open accepted"; an early result ends it.
      const openBy = Math.min(deadline, this.now() + 10_000);
      while (upTo === 0 && !outcome && this.now() < openBy) await wait(openBy - this.now());
      if (outcome) return await finish(outcome);
      if (upTo === 0) {
        abort('timeout');
        return await fail('timeout', 'The workstation did not accept the upload in time.');
      }

      const hash = createHash('sha256');
      let seq = 0;
      let total = 0;
      let carry: Buffer = Buffer.alloc(0);
      const sendChunk = async (data: Buffer): Promise<boolean> => {
        while (seq >= upTo && !outcome && this.now() < deadline) await wait(deadline - this.now());
        if (outcome) return false;
        if (this.now() >= deadline) return false;
        send('storage.write.chunk', { seq, data: data.toString('base64') });
        seq++;
        return true;
      };
      const iterator = req.source[Symbol.asyncIterator]();
      try {
        for (;;) {
          if (outcome || req.signal?.aborted) break;
          const next = await Promise.race([
            iterator.next(),
            new Promise<'deadline'>((resolve) =>
              setTimeout(() => resolve('deadline'), Math.max(0, deadline - this.now())).unref?.(),
            ),
          ]);
          if (next === 'deadline') break;
          if (next.done) break;
          const buf = next.value as Buffer;
          total += buf.length;
          if (total > req.size) {
            abort('too_large');
            return await fail('too_large', 'More data arrived than announced.');
          }
          hash.update(buf);
          carry = carry.length ? Buffer.concat([carry, buf]) : buf;
          while (carry.length >= STORAGE_CHUNK_BYTES) {
            if (!(await sendChunk(carry.subarray(0, STORAGE_CHUNK_BYTES)))) break;
            carry = carry.subarray(STORAGE_CHUNK_BYTES);
          }
        }
      } finally {
        void iterator.return?.();
      }
      let digest = '';
      if (!outcome && !req.signal?.aborted && this.now() < deadline) {
        if (total !== req.size) {
          abort('client_gone');
          return await fail('invalid', 'The upload ended before the announced size.');
        }
        if (carry.length) await sendChunk(carry);
        if (!outcome && this.now() < deadline) {
          digest = hash.digest('hex');
          send('storage.write.end', { chunks: seq, size: total, sha256: digest });
        }
        while (!outcome && this.now() < deadline) await wait(deadline - this.now());
      }
      if (!outcome) {
        const gone = req.signal?.aborted === true;
        abort(gone ? 'client_gone' : 'timeout');
        return await fail(
          gone ? 'unavailable' : 'timeout',
          gone ? 'The upload was interrupted.' : 'The storage did not answer in time.',
        );
      }
      const done = outcome as StorageWriteResult;
      if (done.ok) {
        const ok = StorageReferenceSchema.safeParse(done.reference);
        if (
          !ok.success ||
          done.reference.size !== total ||
          done.reference.sha256 !== digest ||
          done.reference.connectionId !== req.connectionId
        )
          return await fail('invalid', 'The workstation returned an unexpected receipt.');
      }
      return await finish(done);
    } finally {
      req.signal?.removeEventListener('abort', onClientGone);
      this.pending.delete(transferId);
    }
  }

  // ------------------------------------------------------------------------------------ frames from the runner

  onCredit(workstationId: string, transferId: string, upTo: number): void {
    const p = this.pending.get(transferId);
    if (p && p.workstationId === workstationId) p.onCredit(upTo);
  }

  onResult(
    workstationId: string,
    transferId: string,
    r: {
      ok: boolean;
      reference?: StorageReference | undefined;
      error?: StorageWriteError | undefined;
      derived?: StorageDerived | undefined;
    },
  ): void {
    const p = this.pending.get(transferId);
    if (!p || p.workstationId !== workstationId) return;
    if (r.ok && r.reference)
      p.onResult({ ok: true, reference: r.reference, ...(r.derived ? { derived: r.derived } : {}) });
    else
      p.onResult({
        ok: false,
        error: r.error ?? storageError('unavailable', 'The storage did not store the file.'),
      });
  }

  /** The runner socket closed: its transfers end as `unavailable` at once. */
  onDisconnect(workstationId: string): void {
    for (const p of this.pending.values()) if (p.workstationId === workstationId) p.onGone();
  }
}

export const STORAGE_RELAY_WINDOW = STORAGE_WINDOW;
