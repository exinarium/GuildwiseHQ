import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnvelope, type ServerToRunnerOf } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addRelayIntegration } from '../src/relay/config.ts';
import { RelayDispatcher, type RelayEvent } from '../src/relay/dispatch.ts';
import { FileRelaySink, relayEventFile } from '../src/relay/generic.ts';
import { type InboundEvent, whatsAppHandler } from '../src/relay/whatsapp/handler.ts';
import { WhatsAppSecretStore } from '../src/relay/whatsapp/store.ts';
import { verifyHandshake, verifySignature } from '../src/relay/whatsapp/verify.ts';
import { RunnerConfigSchema } from '../src/config.ts';
import { RunnerKeys } from '../src/secrets/keys.ts';
import { redact } from '../src/secrets/redact.ts';
import type { Logger } from '../src/log.ts';

const ID = '0198f2a0-0000-7000-8000-000000000001';
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TOKEN = 'verify-token-xyz-123';
const sign = (body: Buffer | string, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

let dir: string;
const logs: string[] = [];
const log: Logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-'));
  logs.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('verifyHandshake', () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
  it('answers the challenge for the right token', () => {
    expect(verifyHandshake(q({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1158201444' }), TOKEN)).toEqual({ status: 200, body: '1158201444' });
  });
  it('refuses a wrong or missing token or mode', () => {
    expect(verifyHandshake(q({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' }), TOKEN).status).toBe(403);
    expect(verifyHandshake(q({ 'hub.mode': 'subscribe', 'hub.challenge': '1' }), TOKEN).status).toBe(403);
    expect(verifyHandshake(q({ 'hub.verify_token': TOKEN, 'hub.challenge': '1' }), TOKEN).status).toBe(403);
    expect(verifyHandshake(q({ 'hub.mode': 'unsubscribe', 'hub.verify_token': TOKEN, 'hub.challenge': '1' }), TOKEN).status).toBe(403);
    expect(verifyHandshake(`hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.verify_token=${TOKEN}&hub.challenge=1`, TOKEN).status).toBe(403);
  });
  it('is 400 without a challenge', () => {
    expect(verifyHandshake(q({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN }), TOKEN).status).toBe(400);
  });
});

describe('verifySignature', () => {
  const body = Buffer.from('{"a":1, "b":"é"}');
  it('accepts the exact bytes', () => expect(verifySignature(body, sign(body), SECRET)).toBe('ok'));
  it('classifies bad headers', () => {
    expect(verifySignature(body, undefined, SECRET)).toBe('missing');
    expect(verifySignature(body, 'sha1=abc', SECRET)).toBe('malformed');
    expect(verifySignature(body, 'sha256=abcd', SECRET)).toBe('malformed');
    expect(verifySignature(body, sign(body).slice(7), SECRET)).toBe('malformed');
    expect(verifySignature(body, sign(body, 'other-secret-value'), SECRET)).toBe('mismatch');
  });
  it('fails for re-serialised or altered bytes', () => {
    const sig = sign(body);
    expect(verifySignature(Buffer.from(JSON.stringify(JSON.parse(body.toString()))), sig, SECRET)).toBe('mismatch');
    expect(verifySignature(Buffer.from(`${body.toString()} `), sig, SECRET)).toBe('mismatch');
    const decomposed = Buffer.from('{"a":1, "b":"é"}');
    expect(verifySignature(decomposed, sig, SECRET)).toBe('mismatch');
  });
});

describe('WhatsAppSecretStore', () => {
  const mk = () => {
    const keys = new RunnerKeys(join(dir, 'k', 'runner-key.pem'));
    const file = join(dir, 'k', 'relay-whatsapp.json');
    return { keys, file, store: new WhatsAppSecretStore({ file, keys }) };
  };
  it('stores only ciphertext, 0600, and redacts', async () => {
    const { store, file } = mk();
    await store.set(ID, { appSecret: SECRET, verifyToken: TOKEN, phoneNumberId: '123456' });
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(TOKEN);
    expect(raw).toContain('h2.');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(redact(`x ${SECRET} y ${TOKEN}`)).not.toContain(SECRET);
    expect(redact(`x ${TOKEN}`)).not.toContain(TOKEN);
    expect(store.get(ID)).toMatchObject({ appSecret: SECRET, verifyToken: TOKEN, phoneNumberId: '123456' });
  });
  it('announces while bound; removal unregisters and drops the id', async () => {
    const { store } = mk();
    expect(store.ids()).toEqual([]);
    await store.set(ID, { appSecret: SECRET, verifyToken: TOKEN });
    expect(store.ids()).toEqual([ID]);
    expect(store.remove(ID)).toBe(true);
    expect(store.ids()).toEqual([]);
    expect(store.remove(ID)).toBe(false);
    expect(redact(`x ${SECRET}`)).toBe(`x ${SECRET}`);
  });
  it('reload picks up a change made by another process', async () => {
    const { store, keys, file } = mk();
    const other = new WhatsAppSecretStore({ file, keys });
    await other.set(ID, { appSecret: SECRET, verifyToken: TOKEN });
    expect(store.ids()).toEqual([]);
    expect(store.reload()).toBe(true);
    expect(store.ids()).toEqual([ID]);
    expect(store.reload()).toBe(false);
  });
  it('a blob moved to another id does not open', async () => {
    const { store, keys, file } = mk();
    await store.set(ID, { appSecret: SECRET, verifyToken: TOKEN });
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const other = '0198f2a0-0000-7000-8000-000000000002';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, JSON.stringify({ [other]: j[ID] }));
    const s2 = new WhatsAppSecretStore({ file, keys });
    expect(s2.ids()).toEqual([]);
    expect(s2.list()[0]?.readable).toBe(false);
    void store;
  });
  it('rejects bad input', async () => {
    const { store } = mk();
    await expect(store.set('nope', { appSecret: SECRET, verifyToken: TOKEN })).rejects.toThrow();
    await expect(store.set(ID, { appSecret: 'short', verifyToken: TOKEN })).rejects.toThrow();
    await expect(store.set(ID, { appSecret: SECRET, verifyToken: 'a b c d e f g h' })).rejects.toThrow();
  });
});

describe('whatsAppHandler', () => {
  const setup = async (intake: { accept: (e: InboundEvent) => Promise<void> }, phoneNumberId?: string) => {
    const keys = new RunnerKeys(join(dir, 'k', 'runner-key.pem'));
    const store = new WhatsAppSecretStore({ file: join(dir, 'k', 'wa.json'), keys });
    await store.set(ID, { appSecret: SECRET, verifyToken: TOKEN, phoneNumberId });
    const sinkDir = join(dir, 'inbox');
    const sink = new FileRelaySink(sinkDir);
    const handler = whatsAppHandler({ store, sink, sinkDir, intake });
    const dispatcher = new RelayDispatcher({
      integrations: () => store.ids().map((id) => ({ id, kind: 'whatsapp_cloud' as const })),
      log,
    });
    dispatcher.register('whatsapp_cloud', handler);
    return { store, sinkDir, handler, dispatcher };
  };
  const event = (over: Partial<RelayEvent> & { body?: Buffer }): RelayEvent => ({
    requestId: '0198f2a0-0000-7000-8000-0000000000aa',
    integrationId: ID,
    kind: 'whatsapp_cloud',
    method: 'POST',
    query: '',
    headers: [],
    body: Buffer.from('{}'),
    receivedAt: new Date('2026-10-31T10:00:00Z'),
    deadline: Date.now() + 5000,
    ...over,
  });
  const ctx = { integration: { id: ID, kind: 'whatsapp_cloud' as const }, log };
  const payload = (phone = '555000111') =>
    Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, messages: [{ id: 'm1' }] } }] }] }));

  it('delivers a correctly signed POST and calls the intake once', async () => {
    const seen: InboundEvent[] = [];
    const { handler, sinkDir } = await setup({ accept: async (e) => void seen.push(e) });
    const body = payload();
    const e = event({ body, headers: [['x-hub-signature-256', sign(body)]] });
    const r = await handler(e, ctx);
    expect(r.status).toBe(200);
    const f = relayEventFile(sinkDir, e);
    expect(existsSync(f)).toBe(true);
    expect(Buffer.from(JSON.parse(readFileSync(f, 'utf8')).bodyBase64, 'base64').equals(body)).toBe(true);
    await new Promise((res) => setImmediate(res));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.file).toBe(f);
    expect(seen[0]?.summary).toMatchObject({ messages: 1, phoneNumberIds: ['555000111'] });
  });
  it('answers 200 before the intake runs, and a never-finishing intake does not hold it up', async () => {
    let called = false;
    const { handler } = await setup({ accept: () => { called = true; return new Promise<void>(() => {}); } });
    const body = payload();
    const r = await handler(event({ body, headers: [['x-hub-signature-256', sign(body)]] }), ctx);
    expect(r.status).toBe(200);
    expect(called).toBe(false);
    await new Promise((res) => setImmediate(res));
    expect(called).toBe(true);
  });
  it('refuses missing (401), malformed, duplicated and wrong signatures (403) without delivery', async () => {
    let calls = 0;
    const { handler, sinkDir } = await setup({ accept: async () => void calls++ });
    const body = payload();
    expect((await handler(event({ body }), ctx)).status).toBe(401);
    expect((await handler(event({ body, headers: [['x-hub-signature-256', 'sha256=zz']] }), ctx)).status).toBe(403);
    expect((await handler(event({ body, headers: [['x-hub-signature-256', sign(body, 'wrong-secret-wrong-secret')]] }), ctx)).status).toBe(403);
    expect((await handler(event({ body, headers: [['x-hub-signature-256', sign(body)], ['x-hub-signature-256', sign(body)]] }), ctx)).status).toBe(403);
    const altered = Buffer.from(`${body.toString()} `);
    expect((await handler(event({ body: altered, headers: [['x-hub-signature-256', sign(body)]] }), ctx)).status).toBe(403);
    await new Promise((res) => setImmediate(res));
    expect(calls).toBe(0);
    expect(existsSync(sinkDir)).toBe(false);
  });
  it('ignores events for another phone number with 200 and no delivery', async () => {
    const { handler, sinkDir } = await setup({ accept: async () => {} }, '999999');
    const body = payload('555000111');
    expect((await handler(event({ body, headers: [['x-hub-signature-256', sign(body)]] }), ctx)).status).toBe(200);
    expect(existsSync(sinkDir) && readdirSync(sinkDir).length > 0).toBe(false);
  });
  it('handshake through the dispatcher returns exactly the challenge; unbound id is 503', async () => {
    const { dispatcher, store } = await setup({ accept: async () => {} });
    const req = (query: string) =>
      makeEnvelope('relay.request', {
        requestId: '0198f2a0-0000-7000-8000-0000000000aa',
        integrationId: ID,
        kind: 'whatsapp_cloud',
        method: 'GET',
        query,
        headers: [],
        body: '',
        deadlineMs: 5000,
      }) as ServerToRunnerOf<'relay.request'>;
    const ok = await dispatcher.dispatch(req(`hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=424242`));
    expect(ok?.status).toBe(200);
    expect(Buffer.from(ok?.body ?? '', 'base64').toString()).toBe('424242');
    expect(ok?.headers?.['content-type']).toContain('text/plain');
    expect((await dispatcher.dispatch(req('hub.mode=subscribe&hub.verify_token=bad&hub.challenge=1')))?.status).toBe(403);
    store.remove(ID);
    expect((await dispatcher.dispatch(req('hub.mode=subscribe')))?.status).toBe(503);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
  it('a failing sink gives a 500 through the dispatcher', async () => {
    const keys = new RunnerKeys(join(dir, 'k', 'runner-key.pem'));
    const store = new WhatsAppSecretStore({ file: join(dir, 'k', 'wa.json'), keys });
    await store.set(ID, { appSecret: SECRET, verifyToken: TOKEN });
    const d = new RelayDispatcher({ integrations: () => [{ id: ID, kind: 'whatsapp_cloud' }], log });
    d.register('whatsapp_cloud', whatsAppHandler({ store, sink: { put: async () => { throw new Error('disk'); } }, sinkDir: dir, intake: { accept: async () => {} } }));
    const body = payload();
    const r = await d.dispatch(
      makeEnvelope('relay.request', {
        requestId: '0198f2a0-0000-7000-8000-0000000000aa',
        integrationId: ID,
        kind: 'whatsapp_cloud',
        method: 'POST',
        query: '',
        headers: [['x-hub-signature-256', sign(body)]],
        body: body.toString('base64'),
        deadlineMs: 5000,
      }) as ServerToRunnerOf<'relay.request'>,
    );
    expect(r?.status).toBe(500);
  });
});

describe('relay config', () => {
  it('refuses to add whatsapp_cloud by hand', () => {
    const r = addRelayIntegration(RunnerConfigSchema.parse({ serverUrl: 'http://x', workstationId: 'w', runnerToken: 't' } as never), ID, 'whatsapp_cloud');
    expect(r.ok).toBe(false);
  });
});
