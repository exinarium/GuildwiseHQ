import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealForRunner, uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp } from './helpers.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const WS = '019e3f6a-7b1c-7a2d-8c3e-0123456789b1';

describe('the runner and the Integrations page', () => {
  it('announces integrationsVersion in hello, answers integration.* commands, and reports on welcome', async () => {
    h = await startHarness({}, { integrationsReport: true });
    const hello = h.server.of('hello')[0];
    expect(hello?.integrationsVersion).toBe(1);
    expect(hello?.sudoKey?.keyId).toMatch(/^[0-9a-f]{16}$/);
    // the welcome triggers integrations.report with the policy
    const report = await h.server.waitFor('integrations.report', () => true, 15_000);
    expect(report.policy).toEqual({ allowWeb: true, primaryPairing: true, machineScopeFromWeb: 'primary' });
    expect(report.integrations.map((i) => i.kind)).toContain('claude-code');

    // a connect for Claude with a sealed token: the runner's answer is a status or a sentence, never the value
    const key = hello?.sudoKey;
    if (!key) throw new Error('no key');
    const requestId = uuidv7();
    const secret = 'sk-ant-api03-runner-test-secret';
    const envelope = await sealForRunner({
      publicKey: key.publicKey,
      keyId: key.keyId,
      workstationId: WS,
      ref: requestId,
      kind: 'claude-code',
      instance: '',
      op: 'connect',
      method: 'api_key',
      fields: { apiKey: secret },
      serverTimeMs: Date.now(),
    });
    h.server.send('command', {
      commandId: 'c-int-1',
      command: 'integration.connect',
      payload: { requestId, kind: 'claude-code', instance: '', method: 'api_key', envelope },
    });
    const res = await h.server.waitFor('command.result', (m) => m.commandId === 'c-int-1', 15_000);
    expect(res.ok).toBe(true);
    // the real `claude` is blocked under tests, so the probe cannot say: saved with a note, never the key
    expect(JSON.stringify(res)).not.toContain(secret);
    expect((res.result as { status?: { kind: string } }).status?.kind).toBe('claude-code');
    const saved = JSON.parse(readFileSync(join(h.dataDir, 'secrets', 'claude.json'), 'utf8'));
    expect(saved).toMatchObject({ authMode: 'api_key', apiKey: secret, via: 'web' });

    // a test command is an answer too
    h.server.send('command', {
      commandId: 'c-int-2',
      command: 'integration.test',
      payload: { requestId: uuidv7(), kind: 'jira', instance: '' },
    });
    const test = await h.server.waitFor('command.result', (m) => m.commandId === 'c-int-2', 15_000);
    expect((test.result as { status: { state: string } }).status.state).toBe('not_connected');

    // nothing the runner sent contains the key
    expect(JSON.stringify(h.server.received)).not.toContain(secret);
  }, 40_000);

  it('an unknown envelope key is an answer, not a command failure', async () => {
    h = await startHarness({}, {});
    const requestId = uuidv7();
    h.server.send('command', {
      commandId: 'c-int-3',
      command: 'integration.connect',
      payload: {
        requestId,
        kind: 'jira',
        instance: '',
        method: 'token',
        envelope: {
          v: 1,
          alg: 'RSA-OAEP-256+A256GCM',
          keyId: 'deadbeefdeadbeef',
          wrappedKey: 'AA==',
          iv: 'AA==',
          ct: 'AA==',
        },
      },
    });
    const res = await h.server.waitFor('command.result', (m) => m.commandId === 'c-int-3', 15_000);
    expect(res.ok).toBe(true);
    expect((res.result as { code: string }).code).toBe('key');
  }, 30_000);
});
