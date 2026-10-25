import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeConfig } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

// "Make main" swaps two accounts: a command delivered twice must not swap twice.
describe('provider.account.promote runs once per nonce', () => {
  it('remembers the answer of a nonce on disk and answers a repeat with the first answer', async () => {
    h = await startHarness();
    saveConfig(join(h.dataDir, 'config.json'), makeConfig(h.server.url));
    const ask = async (commandId: string, nonce: string) => {
      h?.server.send('command', {
        commandId,
        command: 'provider.account.promote',
        payload: { scope: 'openai', key: 'ghost', nonce },
      });
      return h?.server.waitFor('command.result', (m) => m.commandId === commandId);
    };
    const first = await ask('cmd-p1', 'nonce-one-1234');
    expect(first).toMatchObject({ ok: true, result: { ok: false } });
    const logged = JSON.parse(readFileSync(join(h.dataDir, 'promote-applied.json'), 'utf8'));
    expect(Object.keys(logged)).toEqual(['openai/ghost/nonce-one-1234']);
    const again = await ask('cmd-p2', 'nonce-one-1234');
    expect((again as { result: unknown }).result).toEqual((first as { result: unknown }).result);
    // another nonce is another click
    await ask('cmd-p3', 'nonce-two-5678');
    expect(
      Object.keys(JSON.parse(readFileSync(join(h.dataDir, 'promote-applied.json'), 'utf8'))),
    ).toHaveLength(2);
  });
});
