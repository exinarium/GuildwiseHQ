import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clamdClient, frameChunk, parseClamdAddress, parseClamdReply } from '../src/storage/scan.ts';

// Built from fragments: no file in the repository holds the test string.
export const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join('');

type Mode = 'reply' | 'silent' | 'early-close';
interface Mock {
  address: string;
  received: () => Buffer;
  close: () => Promise<void>;
}

/** A clamd stand-in on loopback TCP. It decides by its configured reply, never by content. */
async function mockClamd(reply: string, mode: Mode = 'reply'): Promise<Mock> {
  const chunks: Buffer[] = [];
  const server = net.createServer((sock) => {
    sock.on('error', () => undefined);
    sock.on('data', (d) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      if (mode === 'early-close') {
        sock.write(`${reply}\0`);
        sock.end();
      } else if (mode === 'reply') {
        const text = all.toString('latin1');
        if (text.startsWith('zPING\0')) sock.write('PONG\0');
        else if (all.subarray(all.length - 4).equals(Buffer.alloc(4))) sock.write(`${reply}\0`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const real = `127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return {
    address: real,
    received: () => Buffer.concat(chunks),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const live: Mock[] = [];
afterEach(async () => {
  for (const m of live.splice(0)) await m.close();
});
const start = async (reply: string, mode: Mode = 'reply') => {
  const m = await mockClamd(reply, mode);
  live.push(m);
  return m;
};
const fileOf = (body: Buffer | string) => {
  const f = join(mkdtempSync(join(tmpdir(), 'gw-scan-')), 'x.part');
  writeFileSync(f, body);
  return f;
};
const sig = () => new AbortController().signal;

describe('parseClamdReply', () => {
  it('only "stream: OK" is clean', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ kind: 'clean' });
    expect(parseClamdReply('stream: OK')).toEqual({ kind: 'clean' });
    expect(parseClamdReply('OK').kind).toBe('failed');
    expect(parseClamdReply('').kind).toBe('failed');
  });
  it('FOUND carries the signature', () => {
    expect(parseClamdReply('stream: Eicar-Signature FOUND\0')).toEqual({
      kind: 'infected',
      signature: 'Eicar-Signature',
    });
  });
  it('size limit and unknown replies are failures', () => {
    expect(parseClamdReply('INSTREAM size limit exceeded. ERROR\0')).toEqual({
      kind: 'failed',
      reason: 'size limit exceeded',
    });
    const u = parseClamdReply('something odd ERROR');
    expect(u.kind).toBe('failed');
  });
  it('caps the raw reply kept for the log', () => {
    const v = parseClamdReply('x'.repeat(500));
    expect(v.kind === 'failed' && v.reason.length).toBeLessThan(200);
  });
});

describe('frameChunk and addresses', () => {
  it('prefixes the length, big-endian; empty is the terminator', () => {
    expect([...frameChunk(Buffer.from('abc'))]).toEqual([0, 0, 0, 3, 97, 98, 99]);
    expect([...frameChunk(Buffer.alloc(0))]).toEqual([0, 0, 0, 0]);
    expect(frameChunk(Buffer.alloc(70_000)).readUInt32BE(0)).toBe(70_000);
  });
  it('parses a socket path and host:port, refuses named pipes', () => {
    expect(parseClamdAddress('/var/run/clamav/clamd.ctl')).toEqual({ path: '/var/run/clamav/clamd.ctl' });
    expect(parseClamdAddress('127.0.0.1:3310')).toEqual({ host: '127.0.0.1', port: 3310 });
    expect(parseClamdAddress('[::1]:3310')).toEqual({ host: '::1', port: 3310 });
    expect(() => parseClamdAddress('\\\\.\\pipe\\clamd')).toThrow(/named pipes/);
    expect(() => parseClamdAddress('nonsense')).toThrow();
    expect(() => parseClamdAddress('host:99999')).toThrow();
  });
});

describe('clamdClient against a mock clamd', () => {
  it('streams zINSTREAM, framed chunks and the terminator; clean on "stream: OK"', async () => {
    const m = await start('stream: OK');
    const body = Buffer.alloc(150_000, 7); // more than two 64 KiB reads
    const v = await clamdClient(m.address).scanFile(fileOf(body), sig());
    expect(v).toEqual({ kind: 'clean' });
    const got = m.received();
    expect(got.subarray(0, 10).toString('latin1')).toBe('zINSTREAM\0');
    let off = 10;
    const data: Buffer[] = [];
    for (;;) {
      const n = got.readUInt32BE(off);
      off += 4;
      if (n === 0) break;
      data.push(got.subarray(off, off + n));
      off += n;
    }
    expect(off).toBe(got.length);
    expect(Buffer.concat(data).equals(body)).toBe(true);
  });

  it('reports a signature for the EICAR content when the engine says FOUND', async () => {
    const m = await start('stream: Eicar-Signature FOUND');
    const v = await clamdClient(m.address).scanFile(fileOf(EICAR), sig());
    expect(v).toEqual({ kind: 'infected', signature: 'Eicar-Signature' });
  });

  it('the size limit reply followed by a close is a failure, never clean', async () => {
    const m = await start('INSTREAM size limit exceeded. ERROR', 'early-close');
    const v = await clamdClient(m.address).scanFile(fileOf(Buffer.alloc(3_000_000, 1)), sig());
    expect(v).toEqual({ kind: 'failed', reason: 'size limit exceeded' });
  });

  it('an unknown reply is a failure', async () => {
    const m = await start('garbage');
    expect((await clamdClient(m.address).scanFile(fileOf('x'), sig())).kind).toBe('failed');
  });

  it('a refused connection is a failure naming the address', async () => {
    const addr = join(tmpdir(), 'gw-no-such-clamd.sock');
    const v = await clamdClient(addr).scanFile(fileOf('x'), sig());
    expect(v.kind).toBe('failed');
    expect(v.kind === 'failed' && v.reason).toContain(addr);
  });

  it('a clamd that never answers ends at the timeout', async () => {
    const m = await start('', 'silent');
    const v = await clamdClient(m.address).scanFile(fileOf('x'), AbortSignal.timeout(150));
    expect(v).toMatchObject({ kind: 'failed', reason: expect.stringContaining('did not answer') });
  });

  it('ping: PONG, no PONG, nothing listening', async () => {
    const m = await start('stream: OK');
    expect(await clamdClient(m.address).ping(1000)).toBe(true);
    const s = await start('', 'silent');
    expect(await clamdClient(s.address).ping(150)).toBe(false);
    const addr = join(tmpdir(), 'gw-no-such-clamd.sock');
    expect(await clamdClient(addr).ping(300)).toBe(false);
  });
});
