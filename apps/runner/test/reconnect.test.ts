import { join } from 'node:path';
import { UNPAIRED_CLOSE_REASON, WS_CLOSE } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  type ClientOptions,
  DEFAULT_BACKOFF,
  RunnerClient,
  toWsUrl,
  UNPAIRED_MESSAGE,
} from '../src/connection/client.ts';
import { Outbox } from '../src/connection/outbox.ts';
import { Runner } from '../src/runner.ts';
import { FakeServer } from './fake-server.ts';
import { cleanupTmp, makeConfig, tmp, waitUntil } from './helpers.ts';

cleanupTmp();

describe('backoff', () => {
  it('is equal jitter (half fixed, half random), doubling from 1 s and capped at 30 s', () => {
    const max = () => 0.999999;
    expect(backoffDelay(0, DEFAULT_BACKOFF, max)).toBeLessThanOrEqual(1000);
    expect(backoffDelay(3, DEFAULT_BACKOFF, max)).toBeLessThanOrEqual(8000);
    expect(backoffDelay(3, DEFAULT_BACKOFF, max)).toBeGreaterThan(7000);
    expect(backoffDelay(10, DEFAULT_BACKOFF, max)).toBeLessThanOrEqual(30_000);
    expect(backoffDelay(10, DEFAULT_BACKOFF, max)).toBeGreaterThan(29_000);
    // the fixed half: the interval never drops below half the ceiling, so the logged waits grow
    expect(backoffDelay(4, DEFAULT_BACKOFF, () => 0)).toBe(8_000);
    expect(backoffDelay(10, DEFAULT_BACKOFF, () => 0)).toBe(15_000);
    expect(backoffDelay(1000, DEFAULT_BACKOFF, max)).toBeLessThanOrEqual(30_000);
    // jittered: different random values give different delays
    expect(backoffDelay(4, DEFAULT_BACKOFF, () => 0.2)).not.toBe(backoffDelay(4, DEFAULT_BACKOFF, () => 0.8));
  });

  it('derives the websocket url', () => {
    expect(toWsUrl('https://aom.example.com')).toBe('wss://aom.example.com/api/runner/ws');
    expect(toWsUrl('http://127.0.0.1:4600/')).toBe('ws://127.0.0.1:4600/api/runner/ws');
  });
});

const newClient = (
  server: FakeServer,
  outbox: Outbox,
  token = server.token,
  extra: Partial<ClientOptions> = {},
) =>
  new RunnerClient({
    ...extra,
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

  it('retries when the opening handshake stalls (server accepts TCP, never upgrades)', async () => {
    const server = await FakeServer.start({ stallUpgrade: true });
    const client = newClient(server, new Outbox(join(tmp(), 'o')), server.token, { handshakeTimeoutMs: 150 });
    client.start();
    try {
      await waitUntil(() => server.stalled >= 3, 5000, 'repeated attempts after handshake timeout');
    } finally {
      await client.stop();
      await server.close();
    }
  });

  it('terminates and retries when the server upgrades but never sends welcome', async () => {
    const server = await FakeServer.start({ noWelcome: true });
    const client = newClient(server, new Outbox(join(tmp(), 'o')), server.token, { welcomeTimeoutMs: 150 });
    client.start();
    try {
      await waitUntil(() => server.connections >= 3, 5000, 'repeated attempts after welcome timeout');
      expect(client.isReady).toBe(false);
    } finally {
      await client.stop();
      await server.close();
    }
  });

  it('terminates and retries when a ready connection goes silent', async () => {
    const server = await FakeServer.start({ heartbeatSec: 1 });
    const client = newClient(server, new Outbox(join(tmp(), 'o')), server.token, { livenessMs: 400 });
    client.start();
    try {
      await waitUntil(() => client.isReady, 5000, 'ready');
      const dropped = new Promise<number>((resolve) => client.once('disconnected', resolve));
      server.goSilent();
      await dropped;
      await waitUntil(() => server.connections >= 2, 5000, 'reconnect after silence');
    } finally {
      await client.stop();
      await server.close();
    }
  });

  it('a healthy ready connection is not dropped by the liveness check', async () => {
    const server = await FakeServer.start({ heartbeatSec: 1 });
    const client = newClient(server, new Outbox(join(tmp(), 'o')), server.token, { livenessMs: 1500 });
    client.start();
    try {
      await waitUntil(() => client.isReady, 5000, 'ready');
      await new Promise((r) => setTimeout(r, 3500));
      expect(client.isReady).toBe(true);
      expect(server.connections).toBe(1);
    } finally {
      await client.stop();
      await server.close();
    }
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
      expect(hello.runtimes.map((r) => r.id).sort()).toEqual(['claude-code', 'direct-model', 'mock']);
      expect(hello.runtimes.find((r) => r.id === 'mock')?.available).toBe(true);
      expect(hello.activeShifts).toEqual([]);
    } finally {
      await runner.stop();
      await server.close();
    }
  });

  it('Runner stops cleanly (exit 0, no retry) with a clear message when the workstation was unpaired', async () => {
    const server = await FakeServer.start();
    const runner = new Runner({ config: makeConfig(server.url), dataDir: tmp() });
    await runner.start();
    try {
      await server.waitFor('hello');
      server.drop(WS_CLOSE.forbidden, UNPAIRED_CLOSE_REASON);
      expect(await runner.fatal).toBe(0);
      expect(runner.unpaired).toBe(true);
      const connections = server.connections;
      await new Promise((r) => setTimeout(r, 300));
      expect(server.connections).toBe(connections);
      expect(UNPAIRED_MESSAGE).toContain('unpaired');
    } finally {
      await runner.stop();
      await server.close();
    }
  });

  it('any other 4403 is still a failure exit', async () => {
    const server = await FakeServer.start();
    const runner = new Runner({ config: makeConfig(server.url), dataDir: tmp() });
    await runner.start();
    try {
      await server.waitFor('hello');
      server.drop(WS_CLOSE.forbidden, 'account deactivated');
      expect(await runner.fatal).toBe(2);
      expect(runner.unpaired).toBe(false);
    } finally {
      await runner.stop();
      await server.close();
    }
  });
});

describe('reconnect after a server redeploy (UAT 1.10.0 finding 4)', () => {
  const logged = () => {
    const lines: string[] = [];
    const rec = (l: string) => lines.push(l);
    return { lines, log: { info: rec, warn: rec, error: rec } };
  };

  it('a reverse proxy answering 502 while the server restarts: every attempt is logged with a growing wait, then it connects', async () => {
    const server = await FakeServer.start({ badGatewayUpgrades: 4 });
    const l = logged();
    const client = newClient(server, new Outbox(join(tmp(), 'o')), server.token, { log: l.log });
    const states: import('../src/connection/client.ts').ConnectionState[] = [];
    client.on('retry', (s) => states.push(s));
    client.start();
    try {
      await waitUntil(() => client.isReady, 10_000, 'connected after the 502s');
      expect(server.badGateways).toBe(4);
      const failures = l.lines.filter((x) => /^connection attempt \d+ failed/.test(x));
      expect(failures).toHaveLength(4);
      expect(failures[0]).toMatch(/HTTP 502/);
      const waits = failures.map((x) => Number(/retrying in (\d+) ms/.exec(x)?.[1]));
      // capped at 100 ms in this client: 10-20, 20-40, 40-80, 50-100
      for (let i = 1; i < 3; i++) expect(waits[i]).toBeGreaterThanOrEqual((waits[i - 1] ?? 0) / 2);
      expect(states.at(-1)).toMatchObject({ connected: false, failedAttempts: 4 });
      expect(states.at(-1)?.lastError).toMatch(/HTTP 502/);
      expect(client.state()).toMatchObject({ connected: true, failedAttempts: 0 });
    } finally {
      await client.stop();
      await server.close();
    }
  });

  it('the server goes away (connection refused) and comes back on the same port: the runner reconnects', async () => {
    const first = await FakeServer.start();
    const port = first.port;
    const l = logged();
    const client = newClient(first, new Outbox(join(tmp(), 'o')), first.token, { log: l.log });
    client.start();
    let second: FakeServer | undefined;
    try {
      await waitUntil(() => client.isReady, 5000, 'ready');
      await first.close();
      await waitUntil(
        () => l.lines.some((x) => /attempt \d+ failed .*ECONNREFUSED/.test(x)),
        5000,
        'refused',
      );
      second = await FakeServer.start({ port });
      await waitUntil(() => client.isReady && (second?.helloCount ?? 0) > 0, 5000, 'reconnected');
    } finally {
      await client.stop();
      await second?.close();
    }
  });

  it('a hard stall (an attempt that never ends) emits `stalled`; the Runner then exits non-zero', async () => {
    const server = await FakeServer.start({ stallUpgrade: true });
    const client = newClient(server, new Outbox(join(tmp(), 'o')), server.token, {
      handshakeTimeoutMs: 60_000,
      stallMs: 300,
    });
    const stalled = new Promise<string>((resolve) => client.once('stalled', resolve));
    client.start();
    try {
      expect(await stalled).toMatch(/no connection attempt progressed/);
    } finally {
      await client.stop();
      await server.close();
    }
  });

  it('the Runner exits with 75 on a stall (Restart=always starts a fresh process; 78 would stop it)', async () => {
    const server = await FakeServer.start({ stallUpgrade: true });
    const runner = new Runner({
      config: makeConfig(server.url),
      dataDir: tmp(),
      connection: { handshakeTimeoutMs: 60_000, stallMs: 300 },
    });
    await runner.start();
    try {
      expect(await runner.fatal).toBe(75);
    } finally {
      await runner.stop();
      await server.close();
    }
  });
});
