import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { FakeServer } from './fake-server.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const tsx = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'cli.mjs');
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (args: string[], input?: string) =>
  execa(process.execPath, [tsx, cli, ...args], {
    reject: false,
    extendEnv: true,
    ...(input ? { input } : {}),
  });

/** A stand-in for a Jira site: accepts one API token, answers /myself. */
async function fakeJira(goodToken: string) {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: req.headers.authorization });
    const want = `Basic ${Buffer.from(`me@acme.com:${goodToken}`).toString('base64')}`;
    if (req.url === '/rest/api/2/myself' && req.headers.authorization === want) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ displayName: 'Pieter' }));
    } else {
      res.statusCode = 401;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('aom-runner jira-connect', () => {
  it('checks the token with Jira, stores it in secrets/ (0600) and not in config.json; status, wrong token and disconnect', async () => {
    const server = await FakeServer.start();
    const jira = await fakeJira('right-token');
    const dir = tmp();
    try {
      await run(['pair', '--server', server.url, '--code', 'ABCD-EFGH', '--data-dir', dir, '--mock']);

      expect((await run(['jira-connect', '--status', '--data-dir', dir])).stdout).toContain('not connected');

      // a wrong token is refused by Jira and nothing is saved
      const bad = await run(
        ['jira-connect', '--base-url', jira.url, '--email', 'me@acme.com', '--data-dir', dir],
        'wrong-token\n',
      );
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr).toContain('Nothing was saved');
      expect(existsSync(join(dir, 'secrets', 'jira.json'))).toBe(false);

      const good = await run(
        ['jira-connect', '--base-url', `${jira.url}/`, '--email', 'me@acme.com', '--data-dir', dir],
        'right-token\n',
      );
      expect(good.exitCode, good.stderr).toBe(0);
      expect(good.stdout).toContain('Connected to');
      expect(good.stdout).toContain('as Pieter');
      expect(good.stdout).not.toContain('right-token');
      const file = join(dir, 'secrets', 'jira.json');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        baseUrl: jira.url,
        email: 'me@acme.com',
        apiToken: 'right-token',
      });
      if (process.platform !== 'win32') {
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, 'secrets')).mode & 0o777).toBe(0o700);
      }
      // never in config.json
      expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('right-token');
      expect(loadConfig(join(dir, 'config.json')).jira).toBeUndefined();

      const status = await run(['jira-connect', '--status', '--data-dir', dir]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain('connected');
      expect(status.stdout).not.toContain('right-token');

      expect((await run(['jira-connect', '--disconnect', '--data-dir', dir])).exitCode).toBe(0);
      expect(existsSync(file)).toBe(false);
      expect((await run(['jira-connect', '--status', '--data-dir', dir])).stdout).toContain('not connected');
    } finally {
      await jira.close();
      await server.close();
    }
  }, 90_000);
});
