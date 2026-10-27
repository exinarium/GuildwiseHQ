import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { FakeServer } from './fake-server.ts';
import { cleanupTmp, makeRepo, tmp } from './helpers.ts';

cleanupTmp();
const tsx = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'cli.mjs');
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (args: string[], env: Record<string, string> = {}) =>
  execa(process.execPath, [tsx, cli, ...args], { reject: false, env: { ...env }, extendEnv: true });

describe('guildwise-runner cli', () => {
  it('pair stores config with mode 0600, repos add/list work, status and doctor run', async () => {
    const server = await FakeServer.start();
    const dir = tmp();
    const repo = makeRepo();
    try {
      const bad = await run(['pair', '--server', server.url, '--code', 'WRONG-CODE', '--data-dir', dir]);
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr).toContain('pairing failed');

      const ok = await run([
        'pair',
        '--server',
        server.url,
        '--code',
        'ABCD-EFGH',
        '--name',
        'Desk',
        '--data-dir',
        dir,
        '--mock',
      ]);
      expect(ok.exitCode, ok.stderr).toBe(0);
      expect(server.pairRequests[0]).toMatchObject({ name: 'Desk', code: 'ABCD-EFGH' });
      const cfgPath = join(dir, 'config.json');
      if (process.platform !== 'win32') expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
      const cfg = loadConfig(cfgPath);
      expect(cfg).toMatchObject({
        serverUrl: server.url,
        runnerToken: server.token,
        runtimes: { mock: { enabled: true } },
      });

      expect((await run(['repos', 'add', repo.scanRoot, '--data-dir', dir])).exitCode).toBe(0);
      const list = await run(['repos', 'list', '--data-dir', dir]);
      expect(list.stdout).toContain(repo.clone);
      expect(loadConfig(cfgPath).repoRoots).toEqual([repo.scanRoot]);

      const status = await run(['status', '--data-dir', dir]);
      expect(status.stdout).toContain('not running');
      const doctor = await run(['doctor', '--data-dir', dir]);
      expect(doctor.stdout).toContain('ok    git');
      expect(doctor.stdout).toContain('ok    server');
      expect(readFileSync(cfgPath, 'utf8')).toContain('aomr_');
    } finally {
      await server.close();
    }
  }, 60_000);

  it('start connects with the stored token, sends hello with the repo and exits cleanly on SIGTERM', async () => {
    const server = await FakeServer.start();
    const dir = tmp();
    const repo = makeRepo();
    await run(['pair', '--server', server.url, '--code', 'ABCD-EFGH', '--data-dir', dir, '--mock']);
    await run(['repos', 'add', repo.scanRoot, '--data-dir', dir]);
    const child = execa(process.execPath, [tsx, cli, 'start', '--data-dir', dir], {
      reject: false,
      extendEnv: true,
    });
    try {
      const hello = await server.waitFor('hello');
      expect(hello.repos.map((r) => r.localPath)).toEqual([repo.clone]);
      expect(hello.runtimes.some((r) => r.id === 'mock' && r.available)).toBe(true);
      // the shift cap (config.json maxConcurrentShifts, default 4) is announced so the Workstations page can show it
      expect(hello.maxConcurrentShifts).toBe(4);
    } finally {
      child.kill('SIGTERM');
      await child;
      await server.close();
    }
  }, 60_000);

  it('a second pair adds a pairing to a running runner; pairings and unpair manage them', async () => {
    const s1 = await FakeServer.start({ token: 'aomr_one' });
    const s2 = await FakeServer.start({ token: 'aomr_two' });
    const dir = tmp();
    const repo = makeRepo();
    expect(
      (
        await run([
          'pair',
          '--server',
          s1.url,
          '--code',
          'ABCD-EFGH',
          '--name',
          'Acme desk',
          '--data-dir',
          dir,
          '--mock',
        ])
      ).exitCode,
    ).toBe(0);
    await run(['repos', 'add', repo.scanRoot, '--data-dir', dir]);
    const child = execa(process.execPath, [tsx, cli, 'start', '--data-dir', dir], {
      reject: false,
      extendEnv: true,
    });
    try {
      await s1.waitFor('hello');
      const before = s1.helloCount;
      const second = await run([
        'pair',
        '--server',
        s2.url,
        '--code',
        'ABCD-EFGH',
        '--name',
        'Globex desk',
        '--data-dir',
        dir,
        '--mock',
      ]);
      expect(second.exitCode, second.stderr).toBe(0);
      expect(second.stdout).toContain('Added next to the existing pairings');
      // the running process starts the new pairing by itself; the first one is not disturbed
      const hello = await s2.waitFor('hello');
      expect(hello.repos.map((r) => r.localPath)).toEqual([repo.clone]);
      expect(s1.helloCount).toBe(before);
      const list = await run(['pairings', '--data-dir', dir]);
      expect(list.stdout).toContain('Acme desk');
      expect(list.stdout).toContain('Globex desk');
      expect(list.stdout).toContain('running');
      const status = await run(['status', '--data-dir', dir]);
      expect(status.stdout).toContain('pairing:');
      expect(status.stdout).toContain(s2.url);
      // repos add reaches every pairing; the second pairing has its own data dir
      const gone = await run(['unpair', 'globex desk', '--data-dir', dir]);
      expect(gone.exitCode, gone.stderr).toBe(0);
      expect((await run(['pairings', '--data-dir', dir])).stdout).not.toContain('Globex desk');
      expect((await run(['unpair', 'nobody', '--data-dir', dir])).exitCode).toBe(1);
    } finally {
      child.kill('SIGTERM');
      await child;
      await Promise.all([s1.close(), s2.close()]);
    }
  }, 90_000);
});
