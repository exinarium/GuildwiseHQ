import { statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.ts';
import { requestRotatedToken } from '../src/connection/rotate.ts';
import { FakeServer } from './fake-server.ts';
import { cleanupTmp, makeConfig, tmp } from './helpers.ts';

cleanupTmp();
const tsx = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'cli.mjs');
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (args: string[]) => execa(process.execPath, [tsx, cli, ...args], { reject: false });

describe('aom-runner rotate-token', () => {
  it('asks the server for a new token over the authenticated socket', async () => {
    const server = await FakeServer.start();
    try {
      const token = await requestRotatedToken({
        url: `${server.url.replace('http', 'ws')}/api/runner/ws`,
        token: server.token,
      });
      expect(token).toBe('aomr_rotated1');
      expect(server.of('token.rotate')).toHaveLength(1);
      // The server now accepts the new token as well.
      expect(
        await requestRotatedToken({ url: `${server.url.replace('http', 'ws')}/api/runner/ws`, token }),
      ).toBe('aomr_rotated2');
    } finally {
      await server.close();
    }
  });

  it('rejects a token the server does not know', async () => {
    const server = await FakeServer.start();
    try {
      await expect(
        requestRotatedToken({
          url: `${server.url.replace('http', 'ws')}/api/runner/ws`,
          token: 'aomr_nope',
          timeoutMs: 3000,
        }),
      ).rejects.toThrow(/rejected the runner token/);
    } finally {
      await server.close();
    }
  });

  it('the command stores the new token with mode 0600 and keeps the rest of the config', async () => {
    const server = await FakeServer.start();
    const dir = tmp();
    try {
      saveConfig(join(dir, 'config.json'), makeConfig(server.url, { repoRoots: ['/work'] }));
      const res = await run(['rotate-token', '--data-dir', dir]);
      expect(res.exitCode, res.stderr).toBe(0);
      expect(res.stdout).toContain('rotated');
      const cfg = loadConfig(join(dir, 'config.json'));
      expect(cfg.runnerToken).toBe('aomr_rotated1');
      expect(cfg.repoRoots).toEqual(['/work']);
      if (process.platform !== 'win32') expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);
    } finally {
      await server.close();
    }
  });

  it('refuses while the runner is running, and leaves the config alone on failure', async () => {
    const server = await FakeServer.start();
    const dir = tmp();
    try {
      const config = makeConfig(server.url, { runnerToken: 'aomr_wrong' });
      saveConfig(join(dir, 'config.json'), config);
      const failed = await run(['rotate-token', '--data-dir', dir]);
      expect(failed.exitCode).toBe(1);
      expect(loadConfig(join(dir, 'config.json')).runnerToken).toBe('aomr_wrong');

      writeFileSync(join(dir, 'status.json'), JSON.stringify({ pid: process.pid, connected: true }));
      const alive = await run(['rotate-token', '--data-dir', dir]);
      expect(alive.exitCode).toBe(1);
      expect(alive.stderr).toContain('stop it first');
    } finally {
      await server.close();
    }
  });
});
