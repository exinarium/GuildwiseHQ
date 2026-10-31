import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope, type ServerToRunnerOf } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, RunnerConfigSchema, saveConfig } from '../src/config.ts';
import type { Logger } from '../src/log.ts';
import { addRelayIntegration, removeRelayIntegration } from '../src/relay/config.ts';
import { type LocalRelayIntegration, RelayDispatcher, type RelayEvent } from '../src/relay/dispatch.ts';
import { FileRelaySink, genericHandler } from '../src/relay/generic.ts';

const ID = '0198f2a0-0000-7000-8000-000000000001';
const REQ = '0198f2a0-0000-7000-8000-0000000000aa';

const request = (over: Record<string, unknown> = {}) =>
  makeEnvelope('relay.request', {
    requestId: REQ,
    integrationId: ID,
    kind: 'generic',
    method: 'POST',
    query: 'a=1&b=%20',
    headers: [['x-hub-signature-256', 'sha256=abc']],
    body: Buffer.from([0xff, 0xfe, 0x00, 0x7b]).toString('base64'),
    deadlineMs: 5000,
    ...over,
  }) as ServerToRunnerOf<'relay.request'>;

const lines: string[] = [];
const log: Logger = {
  info: (m) => lines.push(m),
  warn: (m) => lines.push(m),
  error: (m) => lines.push(m),
};
const mine = (kind: LocalRelayIntegration['kind'] = 'generic'): LocalRelayIntegration[] => [{ id: ID, kind }];

beforeEach(() => {
  lines.length = 0;
});

describe('RelayDispatcher', () => {
  it('hands the registered handler the exact bytes, headers and query, and returns its reply', async () => {
    const seen: RelayEvent[] = [];
    const d = new RelayDispatcher({ integrations: () => mine(), log });
    d.register('generic', async (e) => {
      seen.push(e);
      return { status: 202, headers: { 'content-type': 'text/plain', 'x-evil': '1' }, body: '123' };
    });
    const out = await d.dispatch(request());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.equals(Buffer.from([0xff, 0xfe, 0x00, 0x7b]))).toBe(true);
    expect(seen[0]?.query).toBe('a=1&b=%20');
    expect(seen[0]?.headers).toEqual([['x-hub-signature-256', 'sha256=abc']]);
    expect(out).toEqual({
      requestId: REQ,
      status: 202,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('123').toString('base64'),
    });
  });

  it('answers 501 when no handler is registered for the kind', async () => {
    const d = new RelayDispatcher({ integrations: () => mine('whatsapp_cloud'), log });
    expect((await d.dispatch(request({ kind: 'whatsapp_cloud' })))?.status).toBe(501);
  });

  it('answers 500 when the handler throws, and logs no content', async () => {
    const d = new RelayDispatcher({ integrations: () => mine(), log });
    d.register('generic', async (e) => {
      throw new TypeError(`secret ${e.body.toString('latin1')} ${e.query}`);
    });
    expect((await d.dispatch(request()))?.status).toBe(500);
    expect(lines).toEqual([`relay handler failed ${ID} ${REQ}: TypeError`]);
  });

  it('answers 503 for an integration this workstation does not serve', async () => {
    const d = new RelayDispatcher({ integrations: () => [], log });
    d.register('generic', async () => ({ status: 200 }));
    expect((await d.dispatch(request()))?.status).toBe(503);
  });

  it('answers 503 when the kind differs from the local one', async () => {
    const d = new RelayDispatcher({ integrations: () => mine('webhook_in'), log });
    d.register('generic', async () => ({ status: 200 }));
    expect((await d.dispatch(request()))?.status).toBe(503);
  });

  it('answers 500 for a reply body over 64 KiB or a status outside 200..599', async () => {
    const d = new RelayDispatcher({ integrations: () => mine(), log });
    d.register('generic', async () => ({ status: 200, body: Buffer.alloc(64 * 1024 + 1) }));
    expect((await d.dispatch(request()))?.status).toBe(500);
    d.register('generic', async () => ({ status: 99 }));
    expect((await d.dispatch(request()))?.status).toBe(500);
    d.register('generic', async () => ({ status: 700 }));
    expect((await d.dispatch(request()))?.status).toBe(500);
  });

  it('sends nothing when the handler is not done by the deadline', async () => {
    const d = new RelayDispatcher({ integrations: () => mine(), log });
    d.register('generic', () => new Promise(() => {}));
    expect(await d.dispatch(request({ deadlineMs: 30 }))).toBeNull();
  });

  it('lists what it serves for the announcement', () => {
    const d = new RelayDispatcher({ integrations: () => mine('form_webhook'), log });
    expect(d.served()).toEqual([{ integrationId: ID, kind: 'form_webhook' }]);
  });
});

describe('generic handler and file sink', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relay-sink-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('answers 200 and stores the event in a 0600 file under a 0700 folder', async () => {
    const d = new RelayDispatcher({ integrations: () => mine(), log });
    d.register('generic', genericHandler(new FileRelaySink(dir)));
    const out = await d.dispatch(request());
    expect(out).toEqual({ requestId: REQ, status: 200 });
    const folder = join(dir, ID);
    const files = readdirSync(folder);
    expect(files).toHaveLength(1);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(statSync(join(folder, files[0] as string)).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const rec = JSON.parse(readFileSync(join(folder, files[0] as string), 'utf8'));
    expect(rec).toMatchObject({ requestId: REQ, integrationId: ID, kind: 'generic', method: 'POST', query: 'a=1&b=%20' });
    expect(Buffer.from(rec.bodyBase64, 'base64').equals(Buffer.from([0xff, 0xfe, 0x00, 0x7b]))).toBe(true);
  });

  it('answers 500 when the sink fails, so the provider retries', async () => {
    const d = new RelayDispatcher({ integrations: () => mine(), log });
    d.register(
      'generic',
      genericHandler({
        put: async () => {
          throw new Error('disk full');
        },
      }),
    );
    expect((await d.dispatch(request()))?.status).toBe(500);
  });
});

describe('relay config', () => {
  const base = RunnerConfigSchema.parse({ serverUrl: 'http://s', workstationId: 'w', runnerToken: 't' });

  it('defaults to no integrations', () => {
    expect(base.relay.integrations).toEqual([]);
  });

  it('adds, replaces and removes an integration, and survives a save and load', () => {
    const a = addRelayIntegration(base, ID, 'generic', 'Shop');
    if (!a.ok) throw new Error(a.error);
    const b = addRelayIntegration(a.config, ID, 'webhook_in');
    if (!b.ok) throw new Error(b.error);
    expect(b.config.relay.integrations).toEqual([{ id: ID, kind: 'webhook_in' }]);
    const dir = mkdtempSync(join(tmpdir(), 'relay-cfg-'));
    try {
      const file = join(dir, 'config.json');
      saveConfig(file, b.config);
      expect(loadConfig(file).relay.integrations).toEqual([{ id: ID, kind: 'webhook_in' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const c = removeRelayIntegration(b.config, ID);
    expect(c.ok && c.config.relay.integrations).toEqual([]);
  });

  it('refuses a bad id, an unknown kind and removing what is not served', () => {
    expect(addRelayIntegration(base, 'nope', 'generic').ok).toBe(false);
    expect(addRelayIntegration(base, ID, 'sms').ok).toBe(false);
    expect(removeRelayIntegration(base, ID).ok).toBe(false);
  });
});
