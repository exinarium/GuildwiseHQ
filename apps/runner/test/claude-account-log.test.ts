import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.ts';
import type { Logger } from '../src/log.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeConfig } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

// The runner logs the provisioning of a Claude account (no secrets) so an owner can see what happened on the machine.
describe('claude.account.ensure is logged', () => {
  it('logs the request and the answer with the account key and folder', async () => {
    const lines: string[] = [];
    const push = (l: string) => (m: string, e?: unknown) =>
      void lines.push(`${l} ${m}${e === undefined ? '' : ` ${JSON.stringify(e)}`}`);
    const log: Logger = { info: push('INFO'), warn: push('WARN'), error: push('ERROR') };
    // not the primary pairing: the web may not change the home folder, so the real home is never touched
    h = await startHarness({}, { log, isPrimaryPairing: () => false });
    saveConfig(join(h.dataDir, 'config.json'), makeConfig(h.server.url));
    const commandId = 'cmd-ensure-log';
    h.server.send('command', {
      commandId,
      command: 'claude.account.ensure',
      payload: { key: 'qalogtest' },
    });
    const res = await h.server.waitFor('command.result', (m) => m.commandId === commandId);
    expect(res, JSON.stringify(res) + lines.join('\n')).toMatchObject({ ok: true });
    expect(lines.some((l) => l.startsWith('INFO claude account qalogtest: provisioning requested'))).toBe(
      true,
    );
    const done = lines.find((l) => l.startsWith('INFO claude account qalogtest: provisioning needs_owner'));
    expect(done).toContain('.claude-gw-qalogtest');
  });
});
