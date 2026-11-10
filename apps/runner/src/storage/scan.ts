import { createReadStream } from 'node:fs';
import { chmod, copyFile, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { execa } from 'execa';

export type ScanVerdict =
  | { kind: 'clean' }
  | { kind: 'infected'; signature: string }
  /** `reason` is for the runner log only; it never reaches the submitter. */
  | { kind: 'failed'; reason: string };

export interface ClamdClient {
  scanFile(file: string, signal: AbortSignal): Promise<ScanVerdict>;
  ping(timeoutMs: number): Promise<boolean>;
}

export type ClamdTarget = { path: string } | { host: string; port: number };

/** `/run/clamav/clamd.ctl` (unix socket) or `host:port` (IPv6 as `[::1]:3310`). */
export function parseClamdAddress(address: string): ClamdTarget {
  const a = address.trim();
  if (a.startsWith('\\\\'))
    throw new Error(
      'clamd has no named pipes: use a unix socket path or host:port (for example 127.0.0.1:3310).',
    );
  if (a.startsWith('/')) return { path: a };
  const m = /^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/.exec(a);
  const port = m ? Number(m[3]) : 0;
  if (!m || port < 1 || port > 65535)
    throw new Error(
      'The clamd address must be a unix socket path or host:port (for example 127.0.0.1:3310).',
    );
  return { host: (m[1] ?? m[2]) as string, port };
}

/** A length-prefixed INSTREAM chunk: 4 bytes big-endian length, then the data. An empty buffer is the terminator. */
export function frameChunk(buf: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(buf.length, 0);
  return buf.length ? Buffer.concat([head, buf]) : head;
}

/** Reads one reply of clamd. Only `stream: OK` is clean; every other answer that is not a FOUND is a failure. */
export function parseClamdReply(text: string): ScanVerdict {
  const t = text.replace(/\0+$/, '').trim();
  if (t === 'stream: OK') return { kind: 'clean' };
  const found = /^stream: (.+) FOUND$/.exec(t);
  if (found) return { kind: 'infected', signature: (found[1] as string).slice(0, 200) };
  if (/size limit exceeded/i.test(t)) return { kind: 'failed', reason: 'size limit exceeded' };
  return { kind: 'failed', reason: `unexpected reply: ${t.slice(0, 100)}` };
}

const READ_CHUNK = 64 * 1024;

/** A clamd client over a unix socket or TCP, with the INSTREAM protocol. Reads and sends bytes, never interprets them. */
export function clamdClient(address: string, opts: { connect?: typeof net.connect } = {}): ClamdClient {
  const target = parseClamdAddress(address);
  const dial = opts.connect ?? net.connect;

  /** Opens a connection, sends `produce`, and returns the reply text (up to the first NUL or the end). */
  const exchange = (
    signal: AbortSignal,
    produce: (sock: net.Socket) => Promise<void>,
  ): Promise<{ reply: string } | { error: string }> =>
    new Promise((resolve) => {
      let done = false;
      let reply = '';
      let sawError: string | undefined;
      const sock = dial(target as net.NetConnectOpts);
      const finish = (r: { reply: string } | { error: string }) => {
        if (done) return;
        done = true;
        signal.removeEventListener('abort', onAbort);
        sock.destroy();
        resolve(r);
      };
      const onAbort = () => finish({ error: 'timeout' });
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      const settleOnReply = () => {
        if (reply.length) finish({ reply });
        else finish({ error: sawError ?? 'clamd closed the connection without an answer' });
      };
      sock.on('data', (d) => {
        reply += d.toString('utf8');
        if (reply.includes('\0')) finish({ reply: reply.slice(0, reply.indexOf('\0')) });
        else if (reply.length > 4096) finish({ error: 'reply too long' });
      });
      sock.on('end', settleOnReply);
      sock.on('close', settleOnReply);
      sock.on('error', (err: NodeJS.ErrnoException) => {
        // EPIPE/ECONNRESET: clamd closes on the size limit after sending its reply, so keep a reply that arrived.
        sawError = err.code ?? err.message;
        if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return;
        finish({ error: sawError });
      });
      sock.once('connect', () => {
        produce(sock).catch((err: NodeJS.ErrnoException) => {
          if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET') return;
          finish({ error: err?.code ?? String(err?.message ?? err) });
        });
      });
    });

  const write = (sock: net.Socket, buf: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      if (sock.destroyed) return reject(Object.assign(new Error('closed'), { code: 'EPIPE' }));
      sock.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  const where = address.trim();
  return {
    async scanFile(file, signal) {
      const r = await exchange(signal, async (sock) => {
        await write(sock, Buffer.from('zINSTREAM\0'));
        const rs = createReadStream(file, { highWaterMark: READ_CHUNK });
        try {
          for await (const chunk of rs) await write(sock, frameChunk(chunk as Buffer));
        } finally {
          rs.destroy();
        }
        await write(sock, frameChunk(Buffer.alloc(0)));
      });
      if ('error' in r)
        return {
          kind: 'failed',
          reason:
            r.error === 'timeout'
              ? 'clamd did not answer in time'
              : `clamd not reachable at ${where}: ${r.error}`,
        };
      return parseClamdReply(r.reply);
    },
    async ping(timeoutMs) {
      const r = await exchange(AbortSignal.timeout(Math.max(1, timeoutMs)), (sock) =>
        write(sock, Buffer.from('zPING\0')),
      );
      return 'reply' in r && r.reply.trim() === 'PONG';
    },
  };
}

// ------------------------------------------------------------------------------------------------ quarantine

export interface QuarantineMeta {
  originalName: string;
  size: number;
  sha256: string;
  signature: string;
  formId: string;
  submissionId: string;
  transferId: string;
  orgId: string;
  field: string;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('.', '');

const aclDone = new Set<string>();

/** Windows: only the current user may read the folder (files inherit). Best effort: the caller logs a failure. */
async function restrictWindows(dir: string): Promise<void> {
  if (aclDone.has(dir)) return;
  const user = process.env.USERNAME;
  if (!user) throw new Error('no user name for the ACL');
  const domain = process.env.USERDOMAIN;
  await execa(
    'icacls',
    [dir, '/inheritance:r', '/grant:r', `${domain ? `${domain}\\` : ''}${user}:(OI)(CI)F`],
    {
      shell: false,
      stdin: 'ignore',
      timeout: 15_000,
    },
  );
  aclDone.add(dir);
}

/**
 * Moves the received bytes into the quarantine folder as `<UTC time>-<sha256>.bin` with a `.json` sidecar. The file is
 * renamed, never opened or executed. Returns the base name (without extension) and any permission warning.
 */
export async function quarantine(
  spoolFile: string,
  dir: string,
  meta: QuarantineMeta,
  now: Date,
): Promise<{ base: string; warning?: string }> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let warning: string | undefined;
  if (process.platform === 'win32') {
    try {
      await restrictWindows(dir);
    } catch (err) {
      warning = `could not restrict the quarantine folder: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else await chmod(dir, 0o700);
  const base = `${stamp(now)}-${meta.sha256}`;
  const bin = join(dir, `${base}.bin`);
  try {
    await rename(spoolFile, bin);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(spoolFile, bin);
    await unlink(spoolFile);
  }
  if (process.platform !== 'win32') await chmod(bin, 0o600);
  const side = {
    originalName: meta.originalName,
    size: meta.size,
    sha256: meta.sha256,
    signature: meta.signature,
    formId: meta.formId,
    submissionId: meta.submissionId,
    transferId: meta.transferId,
    organisationId: meta.orgId,
    field: meta.field,
    quarantinedAt: now.toISOString(),
  };
  await writeFile(join(dir, `${base}.json`), `${JSON.stringify(side, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { base, ...(warning ? { warning } : {}) };
}
