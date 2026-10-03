import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backoffDelay, DEFAULT_BACKOFF, RunnerClient, toWsUrl } from '../src/connection/client.ts';
import { Outbox } from '../src/connection/outbox.ts';
import { Runner } from '../src/runner.ts';
import { FakeServer } from './fake-server.ts';
import { cleanupTmp, makeConfig, tmp, waitUntil } from './helpers.ts';

cleanupTmp();

describe('backoff', () => {
  it('is full jitter, doubling from 1 s and capped at 30 s', () => {
    const max = () => 0.999999;
    expect(backoffDelay(0, DEFAULT_BACKOFF, max)).toBeLessThanOrEqual(1000);
    expect(backoffDelay(3, DEFAULT_BACKOFF, max)).toBeLessThanOrEqual(8000);
    expect(backoffDelay(3, DEFAULT_BACKOFF, max)).toBeGreaterThan(7000);
    expect(backoffDelay(10, DEFAULT_BACKOFF, max)).toBeLessThanOrEqual(30_000);
    expect(backoffDelay(10, DEFAULT_BACKOFF, max)).toBeGreaterThan(29_000);
    expect(backoffDelay(5, DEFAULT_BACKOFF, () => 0)).toBe(0);
    // jittered: different random values give different delays
    expect(backoffDelay(4, DEFAULT_BACKOFF, () => 0.2)).not.toBe(backoffDelay(4, DEFAULT_BACKOFF, () => 0.8));
  });

  it('derives the websocket url', () => {
    expect(toWsUrl('https://aom.example.com')).toBe('wss://aom.example.com/api/runner/ws');
    expect(toWsUrl('http://127.0.0.1:4600/')).toBe('ws://127.0.0.1:4600/api/runner/ws');
  });
});

const newClient = (server: FakeServer, outbox: Outbox, token = server.token) =>
  new RunnerClient({
    url: toWsUrl(server.url),
    token,
    outbox,
    backoff: { baseMs: 20, capMs: 100, resetAfterMs: 60_000 },
    buildHello: async () => ({
      runnerVersion: 't',
      protocol: 1,
      platform: 'linux',
      hostname: 'h',
      runtimes: [],
      repos: [{ remoteUrl: 'git@x:y/z.git', localPath: '/z', headBranch: 'main' }],
      activeShifts: [],
    }),
    buildHeartbeat: () => ({ activeShifts: [], load: { runningShifts: 0 } }),
  });

describe('connection', () => {
  it('sends hello with repos and runtimes, then heartbeats at the interval the server sets', async () => {
    const server = await FakeServer.start({ heartbeatSec: 1 });
    const client = newClient(server, new Outbox(join(tmp(), 'o')));
    client.start();
    try {
      const hello = await server.waitFor('hello');
      expect(hello.repos).toHaveLength(1);
      expect(hello.protocol).toBe(1);
      await server.waitFor('outbox.flushed');
      await waitUntil(() => server.of('heartbeat').length >= 2, 5000, 'two heartbeats');
    } finally {
      await client.stop();
      await server.close();
    }
  });

  it('reconnects after a drop with a new hello and keeps going', async () => {
    const server = await FakeServer.start();
    const client = newClient(server, new Outbox(join(tmp(), 'o')));
    client.start();
    try {
      await waitUntil(() => client.isReady, 5000, 'ready');
      server.drop();
      await waitUntil(() => server.helloCount >= 2 && client.isReady, 5000, 'reconnect');
      expect(server.connections).toBe(2);
    } finally {
      await client.stop();
      await server.close();
    }
  });

  it('persists acked messages, resends them after reconnect and after a process restart, then flushes', async () => {
    // Server that never acks, so entries stay in the outbox.
    const server = await FakeServer.start({ autoAck: false });
    const dir = join(tmp(), 'o');
    const c1 = newClient(server, new Outbox(dir));
    c1.start();
    await waitUntil(() => c1.isReady, 5000, 'ready');
    const id = c1.send('shift.accepted', { shiftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789aa' });
    await waitUntil(() => server.of('shift.accepted').length === 1, 5000, 'first delivery');
    // Reconnect: same id is resent.
    server.drop();
    await waitUntil(() => server.of('shift.accepted').length === 2, 5000, 'resend after reconnect');
    expect(server.of('shift.accepted').map((m) => m.id)).toEqual([id, id]);
    await c1.stop();

    // "Restart of the runner process": a brand new client and outbox instance on the same directory.
    const before = server.helloCount;
    const c2 = newClient(server, new Outbox(dir));
    c2.start();
    const flushed = server.received.length;
    await waitUntil(() => server.helloCount > before, 5000, 'new hello');
    const hello = server.of('hello').at(-1);
    expect(hello?.outboxPending).toBe(1);
    await waitUntil(() => server.of('shift.accepted').length === 3, 5000, 'resend after restart');
    const after = server.received.slice(flushed).map((m) => m.type);
    expect(after.indexOf('shift.accepted')).toBeLessThan(after.indexOf('outbox.flushed'));
    // Ack it: the entry is gone.
    server.send('ack', { ackOf: id });
    await waitUntil(() => new Outbox(dir).count() === 0, 5000, 'outbox emptied');
    await c2.stop();
    await server.close();
  });

  it('a wrong token is fatal (4401) and not retried', async () => {
    const server = await FakeServer.start();
    const client = newClient(server, new Outbox(join(tmp(), 'o')), 'aomr_wrong');
    const fatal = new Promise<number>((resolve) => client.once('fatal', (code) => resolve(code)));
    client.start();
    expect(await fatal).toBe(4401);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.connections).toBe(0);
    await client.stop();
    await server.close();
  });

  it('Runner end to end: connects, reports repos and runtimes in hello', async () => {
    const server = await FakeServer.start();
    const runner = new Runner({ config: makeConfig(server.url), dataDir: tmp() });
    await runner.start();
    try {
      const hello = await server.waitFor('hello');
      expect(hello.runtimes.map((r) => r.id).sort()).toEqual(['claude-code', 'mock']);
      expect(hello.runtimes.find((r) => r.id === 'mock')?.available).toBe(true);
      expect(hello.activeShifts).toEqual([]);
    } finally {
      await runner.stop();
      await server.close();
    }
  });
});
