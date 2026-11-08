import type { GrantDto } from '@aom/shared/forms';

export type DirectGrant = GrantDto['grant'];

/** The browser could not reach the storage provider at all (page rules or CORS), before the provider took a byte. */
export class DirectBlockedError extends Error {
  constructor() {
    super('blocked');
    this.name = 'DirectBlockedError';
  }
}
/** The grant ran out or the provider lost the upload: ask a new grant once and start again. */
export class DirectExpiredError extends Error {
  constructor() {
    super('expired');
    this.name = 'DirectExpiredError';
  }
}

export interface DirectResult {
  providerId?: string;
  etag?: string;
}

interface Hooks {
  onProgress(sent: number, total: number): void;
  /** The next byte the provider expects (resume), or null when the upload cannot resume. */
  offset(): Promise<number | null>;
  /** Test seam. */
  xhr?: () => XMLHttpRequest;
  wait?: (ms: number) => Promise<void>;
}

const MAX_TRIES = 5;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Answer {
  status: number;
  body: string;
  range: string | null;
  etag: string | null;
}

/** One request with upload progress (fetch has none). Rejects with `network` when the request could not be made. */
function send(
  g: DirectGrant,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (n: number) => void,
  make: () => XMLHttpRequest,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const x = make();
    x.open(g.method, g.url);
    x.withCredentials = false;
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () =>
      resolve({
        status: x.status,
        body: x.responseText ?? '',
        range: x.getResponseHeader('range'),
        etag: x.getResponseHeader('etag'),
      });
    x.onerror = () => reject(new Error('network'));
    x.ontimeout = () => reject(new Error('network'));
    x.send(body);
  });
}

/**
 * Sends one file straight to the storage provider with the grant. Chunks with Content-Range for OneDrive and Google
 * Drive (the grant says the chunk size), one PUT for S3. After an interruption it asks for the offset and goes on, at
 * most five times. Never touches this server.
 */
export async function directUpload(file: File, g: DirectGrant, hooks: Hooks): Promise<DirectResult> {
  const make = hooks.xhr ?? (() => new XMLHttpRequest());
  const wait = hooks.wait ?? sleep;
  const total = file.size;
  let sent = 0;
  let started = false;
  let tries = 0;
  for (;;) {
    try {
      if (g.chunkBytes === null) {
        const a = await send(g, file, g.headers, (n) => hooks.onProgress(n, total), make);
        started = true;
        if (a.status >= 200 && a.status < 300) {
          hooks.onProgress(total, total);
          return a.etag ? { etag: a.etag.replace(/"/g, '') } : {};
        }
        if (a.status === 403 || a.status === 400 || a.status === 412) throw new DirectExpiredError();
        throw new Error('network');
      }
      while (sent < total) {
        const end = Math.min(total, sent + g.chunkBytes);
        const a = await send(
          g,
          file.slice(sent, end),
          { 'content-range': `bytes ${sent}-${end - 1}/${total}` },
          (n) => hooks.onProgress(sent + n, total),
          make,
        );
        started = true;
        if (a.status === 200 || a.status === 201) {
          hooks.onProgress(total, total);
          let id: string | undefined;
          try {
            id = (JSON.parse(a.body) as { id?: string }).id;
          } catch {
            id = undefined;
          }
          return id ? { providerId: id } : {};
        }
        if (a.status === 202 || a.status === 308) {
          sent = end;
          tries = 0;
          continue;
        }
        if (a.status === 404 || a.status === 410) throw new DirectExpiredError();
        throw new Error('network');
      }
      throw new DirectExpiredError();
    } catch (err) {
      if (err instanceof DirectExpiredError) throw err;
      // The first request got no answer at all: the page rules or CORS stopped it, so this browser cannot send directly.
      if (!started) throw new DirectBlockedError();
      if (++tries > MAX_TRIES) throw new DirectExpiredError();
      await wait(Math.min(8000, 500 * 2 ** tries));
      const off = await hooks.offset();
      if (off === null) throw new DirectExpiredError();
      sent = Math.min(off, total);
    }
  }
}
