import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { autoReply, createIntegration, type Made, makeBusiness, relayRows, serve } from './helpers/relay.ts';
import { createWorld, type World } from './helpers/world.ts';

const MIB = 1024 * 1024;
let w: World;

async function boot(env: Record<string, string> = {}) {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_RELAY_RATE_BURST: '50', ...env } });
  await makeBusiness(w);
}
afterAll(async () => {
  await closeAdminPool();
});
beforeEach(async () => {
  await q('TRUNCATE relay_requests, relay_presence, relay_integrations CASCADE');
});

const post = (path: string, payload: Buffer) => w.t.app.inject({ method: 'POST', url: path, payload });

async function serving(...ms: Made[]) {
  const r = await w.connectRunner();
  const seen = autoReply(r, () => ({ status: 200 }));
  await serve(
    r,
    ms.map((m) => ({ integrationId: m.integration.id, kind: m.integration.kind })),
  );
  return { r, seen };
}

describe('default limits', () => {
  beforeAll(() => boot());
  afterAll(() => w.t.close());

  it('whatsapp_cloud accepts 3 MiB, forwards it byte for byte, and refuses one byte more', async () => {
    const m = await createIntegration(w, 'whatsapp_cloud');
    const { r, seen } = await serving(m);
    const body = Buffer.alloc(3 * MIB, 'w');
    expect((await post(m.path, body)).statusCode).toBe(200);
    expect(Buffer.from(seen[0].body, 'base64').equals(body)).toBe(true);
    const res = await post(m.path, Buffer.alloc(3 * MIB + 1));
    expect(res.statusCode).toBe(413);
    expect(res.body).toBe('');
    expect(seen).toHaveLength(1);
    expect((await relayRows()).map((x) => x.outcome)).toEqual(['forwarded', 'rejected_size']);
    r.ws.close();
  });

  it('another kind keeps 1 MiB', async () => {
    const m = await createIntegration(w, 'generic');
    const { r } = await serving(m);
    expect((await post(m.path, Buffer.alloc(MIB))).statusCode).toBe(200);
    expect((await post(m.path, Buffer.alloc(MIB + 1))).statusCode).toBe(413);
    r.ws.close();
  });

  it('refuses a chunked body that grows past the limit', async () => {
    const m = await createIntegration(w, 'generic');
    const { r, seen } = await serving(m);
    const chunk = Buffer.alloc(256 * 1024, 'c');
    const res = await w.t.app.inject({
      method: 'POST',
      url: m.path,
      headers: { 'transfer-encoding': 'chunked' },
      payload: Readable.from(Array.from({ length: 6 }, () => chunk)) as never,
    });
    expect(res.statusCode).toBe(413);
    expect(seen).toHaveLength(0);
    r.ws.close();
  });
});

describe('global limit of 512 KiB', () => {
  beforeAll(() => boot({ AOM_RELAY_MAX_BODY_BYTES: String(512 * 1024) }));
  afterAll(() => w.t.close());

  it('applies to another kind, while whatsapp_cloud keeps 3 MiB', async () => {
    const g = await createIntegration(w, 'generic');
    const wa = await createIntegration(w, 'whatsapp_cloud', 'WA');
    const { r } = await serving(g, wa);
    expect((await post(g.path, Buffer.alloc(512 * 1024))).statusCode).toBe(200);
    expect((await post(g.path, Buffer.alloc(512 * 1024 + 1))).statusCode).toBe(413);
    expect((await post(wa.path, Buffer.alloc(3 * MIB))).statusCode).toBe(200);
    r.ws.close();
  });
});

describe('override for whatsapp_cloud', () => {
  beforeAll(() => boot({ AOM_RELAY_MAX_BODY_BYTES_BY_KIND: 'whatsapp_cloud=2097152' }));
  afterAll(() => w.t.close());

  it('wins over the built-in default', async () => {
    const m = await createIntegration(w, 'whatsapp_cloud');
    const { r } = await serving(m);
    expect((await post(m.path, Buffer.alloc(2 * MIB))).statusCode).toBe(200);
    expect((await post(m.path, Buffer.alloc(2 * MIB + 1))).statusCode).toBe(413);
    r.ws.close();
  });
});
