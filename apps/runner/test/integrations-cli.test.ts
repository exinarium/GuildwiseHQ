import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { FakeServer } from './fake-server.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();
const tsx = join(dirname(createRequire(import.meta.url).resolve('tsx/package.json')), 'dist', 'cli.mjs');
const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (args: string[], input?: string, home = '/nonexistent-aom-home') =>
  execa(process.execPath, [tsx, cli, ...args], {
    reject: false,
    extendEnv: true,
    env: { VITEST: '1', AOM_RUNNER_HOME: home },
    ...(input ? { input } : {}),
  });

describe('aom-runner integrations and auth', () => {
  it('lists the integrations, switches the web policy, and `auth` writes secrets/claude.json without touching config.json', async () => {
    const server = await FakeServer.start();
    const dir = tmp();
    try {
      await run(['pair', '--server', server.url, '--code', 'ABCD-EFGH', '--data-dir', dir, '--mock']);
      const list = await run(['integrations', '--data-dir', dir]);
      expect(list.exitCode, list.stderr).toBe(0);
      expect(list.stdout).toContain('web connect on');
      expect(list.stdout).toContain('machine-wide logins from the web: allowed (primary pairing)');
      expect(list.stdout).toContain('jira: Not connected');

      const off = await run(['integrations', 'allow-web', 'off', '--data-dir', dir]);
      expect(off.stdout + off.stderr).toContain('now refused');
      expect(loadConfig(join(dir, 'config.json')).integrations.allowWeb).toBe(false);
      expect((await run(['integrations', '--data-dir', dir])).stdout).toContain('web connect OFF');
      expect((await run(['integrations', 'allow-web', 'maybe', '--data-dir', dir])).exitCode).not.toBe(0);
      await run(['integrations', 'allow-web', 'on', '--data-dir', dir]);
      expect(loadConfig(join(dir, 'config.json')).integrations.allowWeb).toBe(true);

      const secret = 'sk-ant-api03-cli-secret-value';
      const auth = await run(['auth', 'api-key', '--data-dir', dir], `${secret}\n`);
      expect(auth.exitCode, auth.stderr).toBe(0);
      expect(auth.stdout).not.toContain(secret);
      expect(auth.stdout).toContain('no restart is needed');
      const file = join(dir, 'secrets', 'claude.json');
      expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
        authMode: 'api_key',
        apiKey: secret,
        via: 'cli',
      });
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain(secret);
      expect(existsSync(file)).toBe(true);
      const after = await run(['integrations', '--data-dir', dir]);
      expect(after.stdout).toContain('claude-code: Connected (api_key)');
    } finally {
      await server.close();
    }
  }, 60_000);
});

describe('aom-runner ceo full-power', () => {
  it('is off by default; on and off change only config.ceo.fullPower; status shows it; a bad value fails', async () => {
    const server = await FakeServer.start();
    const dir = tmp();
    try {
      await run(['pair', '--server', server.url, '--code', 'ABCD-EFGH', '--data-dir', dir, '--mock']);
      expect(loadConfig(join(dir, 'config.json')).ceo.fullPower).toBe(false);
      const on = await run(['ceo', 'full-power', 'on', '--data-dir', dir]);
      expect(on.exitCode, on.stderr).toBe(0);
      expect(on.stdout).toContain('CEO full power is ON');
      expect(on.stdout).toContain('Restart the runner');
      expect(loadConfig(join(dir, 'config.json')).ceo.fullPower).toBe(true);
      expect((await run(['ceo', 'full-power', 'status', '--data-dir', dir])).stdout).toContain('is ON');
      const off = await run(['ceo', 'full-power', 'off', '--data-dir', dir]);
      expect(off.stdout).toContain('CEO full power is off');
      expect(loadConfig(join(dir, 'config.json')).ceo.fullPower).toBe(false);
      expect((await run(['ceo', 'full-power', 'maybe', '--data-dir', dir])).exitCode).not.toBe(0);
    } finally {
      await server.close();
    }
  });
});
