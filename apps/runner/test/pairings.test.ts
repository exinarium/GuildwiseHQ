import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNPAIRED_CLOSE_REASON, WS_CLOSE } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.ts';
import { RunnerHost } from '../src/host.ts';
import { nullLogger } from '../src/log.ts';
import { addPairing, findPairing, loadIndex, removePairing } from '../src/pairings.ts';
import { FakeServer } from './fake-server.ts';
import { cleanupTmp, makeConfig, tmp, waitUntil } from './helpers.ts';

cleanupTmp();

const WS_A = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const WS_B = '019e3f6a-7b1c-7a2d-8c3e-0123456789b2';

describe('pairing index', () => {
  it('migrates a single-pairing data dir in place without moving anything', () => {
    const root = tmp();
    saveConfig(join(root, 'config.json'), makeConfig('http://aom.example.com/', { repoRoots: ['/src'] }));
    const before = readFileSync(join(root, 'config.json'), 'utf8');
    const index = loadIndex(root);
    expect(index.pairings).toHaveLength(1);
    expect(index.pairings[0]).toMatchObject({ dir: '.', serverUrl: 'http://aom.example.com' });
    expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe(before);
    expect(existsSync(join(root, 'pairings.json'))).toBe(true);
    // idempotent
    expect(loadIndex(root)).toEqual(index);
  });

  it('is empty for an unpaired dir', () => {
    expect(loadIndex(tmp()).pairings).toEqual([]);
  });

  it('the first pairing lives in the data dir, later ones in pairings/<id> with settings but no credentials', () => {
    const root = tmp();
    const first = addPairing(root, {
      serverUrl: 'https://one.example.com',
      label: 'Desk',
      workstationId: WS_A,
      runnerToken: 'aomr_one',
    });
    expect(first.entry.dir).toBe('.');
    const c1 = loadConfig(first.configPath);
    saveConfig(first.configPath, {
      ...c1,
      repoRoots: ['/home/me/src'],
      jira: { baseUrl: 'https://j', apiToken: 'secret' },
      runtimes: {
        ...c1.runtimes,
        'claude-code': { ...c1.runtimes['claude-code'], authMode: 'api_key', apiKey: 'sk-secret' },
      },
    });
    const second = addPairing(root, {
      serverUrl: 'https://two.example.com',
      label: 'Desk',
      workstationId: WS_B,
      runnerToken: 'aomr_two',
    });
    expect(second.entry.dir).toBe(`pairings/${second.entry.id}`);
    expect(second.count).toBe(2);
    expect(second.replaced).toBe(false);
    const c2 = loadConfig(second.configPath);
    expect(c2).toMatchObject({
      serverUrl: 'https://two.example.com',
      runnerToken: 'aomr_two',
      workstationId: WS_B,
      repoRoots: ['/home/me/src'],
    });
    expect(c2.jira).toBeUndefined();
    expect(c2.runtimes['claude-code'].apiKey).toBeUndefined();
    expect(c2.runtimes['claude-code'].authMode).toBe('default');
    // the first pairing is untouched
    expect(loadConfig(first.configPath)).toMatchObject({
      runnerToken: 'aomr_one',
      jira: { apiToken: 'secret' },
    });
    if (process.platform !== 'win32') expect(statSync(second.configPath).mode & 0o777).toBe(0o600);
  });

  it('the same server and name again is a re-pair: credentials replaced, settings kept, no duplicate', () => {
    const root = tmp();
    addPairing(root, {
      serverUrl: 'https://one.example.com',
      label: 'Desk',
      workstationId: WS_A,
      runnerToken: 'aomr_one',
    });
    const again = addPairing(root, {
      serverUrl: 'https://one.example.com/',
      label: 'Desk',
      workstationId: WS_B,
      runnerToken: 'aomr_new',
    });
    expect(again.replaced).toBe(true);
    expect(again.count).toBe(1);
    expect(loadConfig(again.configPath)).toMatchObject({ runnerToken: 'aomr_new', workstationId: WS_B });
    // a different name on the same server is an additional pairing (another account or organization)
    const other = addPairing(root, {
      serverUrl: 'https://one.example.com',
      label: 'Desk for Acme',
      workstationId: WS_A,
      runnerToken: 'aomr_acme',
    });
    expect(other.count).toBe(2);
    expect(other.entry.id).not.toBe(again.entry.id);
  });

  it('finds a pairing by id, name, workstation id or unique prefix and refuses ambiguity', () => {
    const root = tmp();
    const a = addPairing(root, {
      serverUrl: 'https://one.example.com',
      label: 'Acme',
      workstationId: WS_A,
      runnerToken: 'aomr_a',
    });
    addPairing(root, {
      serverUrl: 'https://one.example.com',
      label: 'Globex',
      workstationId: WS_B,
      runnerToken: 'aomr_b',
    });
    const index = loadIndex(root);
    expect(findPairing(index, 'acme').id).toBe(a.entry.id);
    expect(findPairing(index, a.entry.id).label).toBe('Acme');
    expect(findPairing(index, WS_B).label).toBe('Globex');
    expect(() => findPairing(index, 'one-example')).toThrow(/matches 2 pairings/);
    expect(() => findPairing(index, 'nope')).toThrow(/no pairing "nope"/);
  });

  it('unpair drops the credentials and keeps the data unless purged', () => {
    const root = tmp();
    addPairing(root, {
      serverUrl: 'https://one.example.com',
      label: 'Acme',
      workstationId: WS_A,
      runnerToken: 'aomr_a',
    });
    const b = addPairing(root, {
      serverUrl: 'https://two.example.com',
      label: 'Globex',
      workstationId: WS_B,
      runnerToken: 'aomr_b',
    });
    removePairing(root, 'globex');
    expect(loadIndex(root).pairings.map((p) => p.label)).toEqual(['Acme']);
    expect(loadConfig(b.configPath).runnerToken).toBe('aomr_removed');
    const c = addPairing(root, {
      serverUrl: 'https://three.example.com',
      label: 'Initech',
      workstationId: WS_B,
      runnerToken: 'aomr_c',
    });
    removePairing(root, 'initech', true);
    expect(existsSync(c.dir)).toBe(false);
  });
});

describe('runner host', () => {
  const quick = { reloadMs: 50 };

  async function pairTo(root: string, server: FakeServer, label: string, workstationId: string) {
    return addPairing(root, {
      serverUrl: server.url,
      label,
      workstationId,
      runnerToken: server.token,
      mock: true,
    });
  }

  it('connects every pairing to its own server with separate data dirs, and picks up one added while running', async () => {
    const s1 = await FakeServer.start({ token: 'aomr_one' });
    const s2 = await FakeServer.start({ token: 'aomr_two' });
    const s3 = await FakeServer.start({ token: 'aomr_three' });
    const root = tmp();
    const host = new RunnerHost({ root, log: nullLogger, mock: true, ...quick });
    try {
      const p1 = await pairTo(root, s1, 'Acme', WS_A);
      const p2 = await pairTo(root, s2, 'Globex', WS_B);
      await host.start();
      await waitUntil(() => s1.helloCount > 0 && s2.helloCount > 0, 15_000, 'both pairings connected');
      expect(host.running.size).toBe(2);
      expect(p1.dir).toBe(root);
      expect(p2.dir).not.toBe(root);
      // each pairing has its own working state under its own directory
      expect(existsSync(join(p2.dir, 'bin'))).toBe(true);
      expect(existsSync(join(p2.dir, 'status.json'))).toBe(true);
      // the first pairing is not disturbed when a third is added while the runner runs
      const hellos1 = s1.helloCount;
      await pairTo(root, s3, 'Initech', '019e3f6a-7b1c-7a2d-8c3e-0123456789c3');
      await waitUntil(() => s3.helloCount > 0, 15_000, 'third pairing connected');
      expect(host.running.size).toBe(3);
      expect(s1.helloCount).toBe(hellos1);
      // removing one stops only that one
      removePairing(root, 'globex');
      await waitUntil(() => host.running.size === 2, 15_000, 'second pairing stopped');
      expect(s1.helloCount).toBe(hellos1);
    } finally {
      await host.stop();
      await Promise.all([s1.close(), s2.close(), s3.close()]);
    }
  }, 60_000);

  it('a pairing the server unpaired is marked and stopped while the other keeps running', async () => {
    const s1 = await FakeServer.start({ token: 'aomr_one' });
    const s2 = await FakeServer.start({ token: 'aomr_two' });
    const root = tmp();
    await pairTo(root, s1, 'Acme', WS_A);
    await pairTo(root, s2, 'Globex', WS_B);
    const host = new RunnerHost({ root, log: nullLogger, mock: true, ...quick });
    try {
      await host.start();
      await waitUntil(() => s1.helloCount > 0 && s2.helloCount > 0, 15_000, 'both connected');
      s2.drop(WS_CLOSE.forbidden, UNPAIRED_CLOSE_REASON);
      await waitUntil(() => host.running.size === 1, 15_000, 'unpaired pairing stopped');
      expect(loadIndex(root).pairings.find((p) => p.label === 'Globex')?.disabled).toBe('unpaired');
      expect(loadIndex(root).pairings.find((p) => p.label === 'Acme')?.disabled).toBeUndefined();
      // the host is still alive: its promise has not resolved
      let done = false;
      void host.fatal.then(() => {
        done = true;
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(done).toBe(false);
    } finally {
      await host.stop();
      await Promise.all([s1.close(), s2.close()]);
    }
  }, 60_000);

  it('ends with exit 0 when the last pairing is unpaired by the server', async () => {
    const s1 = await FakeServer.start({ token: 'aomr_one' });
    const root = tmp();
    await pairTo(root, s1, 'Acme', WS_A);
    const host = new RunnerHost({ root, log: nullLogger, mock: true, ...quick });
    try {
      await host.start();
      await waitUntil(() => s1.helloCount > 0, 15_000, 'connected');
      s1.drop(WS_CLOSE.forbidden, UNPAIRED_CLOSE_REASON);
      expect(await host.fatal).toBe(0);
      expect(host.unpaired).toBe(true);
    } finally {
      await host.stop();
      await s1.close();
    }
  }, 60_000);

  it('restarts a pairing whose credentials changed (a re-pair)', async () => {
    const s1 = await FakeServer.start({ token: 'aomr_one' });
    const root = tmp();
    const p = await pairTo(root, s1, 'Acme', WS_A);
    const host = new RunnerHost({ root, log: nullLogger, mock: true, ...quick });
    try {
      await host.start();
      await waitUntil(() => s1.helloCount > 0, 15_000, 'connected');
      const first = host.running.get(p.entry.id)?.runner;
      s1.tokens.add('aomr_fresh');
      writeFileSync(p.configPath, JSON.stringify({ ...loadConfig(p.configPath), runnerToken: 'aomr_fresh' }));
      await waitUntil(() => host.running.get(p.entry.id)?.runner !== first, 15_000, 'runner restarted');
      await waitUntil(() => s1.helloCount >= 2, 15_000, 'reconnected with the new token');
    } finally {
      await host.stop();
      await s1.close();
    }
  }, 60_000);

  it('shares one concurrency budget: the machine limit minus what the other pairings run', async () => {
    const s1 = await FakeServer.start({ token: 'aomr_one' });
    const s2 = await FakeServer.start({ token: 'aomr_two' });
    const root = tmp();
    const p1 = await pairTo(root, s1, 'Acme', WS_A);
    const p2 = await pairTo(root, s2, 'Globex', WS_B);
    for (const p of [p1, p2])
      saveConfig(p.configPath, { ...loadConfig(p.configPath), maxConcurrentShifts: 2 });
    const host = new RunnerHost({ root, log: nullLogger, mock: true, ...quick });
    try {
      await host.start();
      const r1 = host.running.get(p1.entry.id)?.runner;
      const r2 = host.running.get(p2.entry.id)?.runner;
      expect(r1 && r2).toBeTruthy();
      // machine limit = 2 (largest per-pairing limit); with nothing running each pairing may use both slots
      const cap = (id: string) => (host as unknown as { capFor(id: string): number }).capFor(id);
      expect(cap(p1.entry.id)).toBe(2);
      // pretend pairing 2 runs one shift
      Object.defineProperty((r2 as NonNullable<typeof r2>).supervisor, 'size', { get: () => 1 });
      expect(cap(p1.entry.id)).toBe(1);
      expect(cap(p2.entry.id)).toBe(2);
    } finally {
      await host.stop();
      await Promise.all([s1.close(), s2.close()]);
    }
  }, 60_000);
});
