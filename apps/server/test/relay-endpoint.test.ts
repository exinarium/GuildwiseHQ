import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { autoReply, createIntegration, type Made, makeBusiness, relayRows, serve } from './helpers/relay.ts';
import { createWorld, pairWorkstation, until, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_RELAY_RATE_BURST: '3', AOM_RELAY_RATE_PER_MINUTE: '60' },
  });
  await makeBusiness(w);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await q('TRUNCATE relay_requests, relay_presence, relay_integrations CASCADE');
});

const hub = () => w.t.app.ctx.services.webhookRelay;
const post = (path: string, payload: Buffer | string, headers: Record<string, string> = {}) =>
  w.t.app.inject({ method: 'POST', url: path, payload, headers });
const get = (path: string, headers: Record<string, string> = {}) =>
  w.t.app.inject({ method: 'GET', url: path, headers });

/** A runner that serves `m` and answers with `reply`; returns it with the requests it sees. */
async function serving(m: Made, reply: Parameters<typeof autoReply>[1]) {
  const r = await w.connectRunner();
  const seen = autoReply(r, reply);
  const res = await serve(r, [{ integrationId: m.integration.id, kind: m.integration.kind }]);
  expect(res.accepted).toEqual([m.integration.id]);
  return { r, seen };
}

describe('forwarding', () => {
  it('delivers the exact bytes, headers and query, and returns exactly the runner status, headers and body', async () => {
    const m = await createIntegration(w, 'generic');
    const { r, seen } = await serving(m, () => ({
      status: 202,
      headers: { 'content-type': 'text/plain', 'x-evil': '1', 'set-cookie': 'a=b' },
      body: 'accepted ✓',
    }));
    const body = Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x80, 0x0d, 0x0a, 0xc3, 0x28]);
    const res = await post(`${m.path}?x=%7B1%7D&y=a+b&x=2`, body, {
      'content-type': 'application/octet-stream',
      'x-hub-signature-256': 'sha256=deadbeef',
      authorization: 'Bearer provider-secret',
      cookie: 'aom_session=guildwise-session',
      'x-aom-org': 'some-org',
      connection: 'x-hop-secret',
      'x-hop-secret': 'hop',
      'x-forwarded-for': '10.0.0.1',
    });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('accepted ✓');
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.headers['x-evil']).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();

    expect(seen).toHaveLength(1);
    const f = seen[0];
    expect(Buffer.from(f.body, 'base64').equals(body)).toBe(true);
    expect(f.query).toBe('x=%7B1%7D&y=a+b&x=2');
    expect(f).toMatchObject({ method: 'POST', integrationId: m.integration.id, kind: 'generic' });
    const names = f.headers.map((h: string[]) => h[0]);
    expect(f.headers).toContainEqual(['x-hub-signature-256', 'sha256=deadbeef']);
    expect(f.headers).toContainEqual(['authorization', 'Bearer provider-secret']);
    expect(f.headers).toContainEqual(['content-type', 'application/octet-stream']);
    for (const stripped of [
      'cookie',
      'x-aom-org',
      'x-hop-secret',
      'connection',
      'host',
      'content-length',
      'x-forwarded-for',
    ])
      expect(names).not.toContain(stripped);
    expect(f.deadlineMs).toBeGreaterThan(0);

    const rows = await relayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: w.owner.id,
      integration_id: m.integration.id,
      kind: 'generic',
      method: 'POST',
      size_bytes: body.length,
      status: 202,
      outcome: 'forwarded',
    });
    expect(rows[0]?.latency_ms).toBeGreaterThanOrEqual(0);
    r.ws.close();
  });

  it('keeps a JSON body whose key order and whitespace a re-serialisation would change', async () => {
    const m = await createIntegration(w);
    const { r, seen } = await serving(m, () => ({ status: 200 }));
    const raw = Buffer.from('{ "z" : 1,\n  "a":   [1 , 2],"é":"\\u00e9" , "a":2 }\n');
    const res = await post(m.path, raw, { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(seen[0].body, 'base64').equals(raw)).toBe(true);
    r.ws.close();
  });

  it('forwards a form post and a post without a content type (not a 415)', async () => {
    const m = await createIntegration(w, 'form_webhook');
    const { r, seen } = await serving(m, () => ({ status: 200 }));
    const form = 'name=Ann&msg=hi+there';
    expect(
      (await post(m.path, form, { 'content-type': 'application/x-www-form-urlencoded' })).statusCode,
    ).toBe(200);
    expect((await post(m.path, form)).statusCode).toBe(200);
    expect(Buffer.from(seen[0].body, 'base64').toString()).toBe(form);
    expect(seen).toHaveLength(2);
    r.ws.close();
  });

  it('forwards a GET with its query and returns the runner body unchanged (the hub.challenge handshake)', async () => {
    const m = await createIntegration(w, 'whatsapp_cloud');
    const { r, seen } = await serving(m, (f) => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: new URLSearchParams(f.query).get('hub.challenge') ?? '',
    }));
    const res = await get(`${m.path}?hub.mode=subscribe&hub.verify_token=VERIFY&hub.challenge=1158201444`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('1158201444');
    expect(seen[0]).toMatchObject({
      method: 'GET',
      body: '',
      query: 'hub.mode=subscribe&hub.verify_token=VERIFY&hub.challenge=1158201444',
    });
    r.ws.close();
  });

  it('passes a runner error status through (the provider retries a non-2xx)', async () => {
    const m = await createIntegration(w);
    const { r } = await serving(m, () => ({ status: 501 }));
    expect((await post(m.path, 'x')).statusCode).toBe(501);
    expect((await relayRows())[0]).toMatchObject({ status: 501, outcome: 'forwarded' });
    r.ws.close();
  });

  it('spreads calls over the runners that serve the integration', async () => {
    const m = await createIntegration(w);
    const a = await serving(m, () => ({ status: 200 }));
    const b = await serving(m, () => ({ status: 200 }));
    // the second connection of the same workstation replaces the first: one server remains
    expect(hub().isServed(m.integration.id)).toBe(1);
    expect((await post(m.path, 'x')).statusCode).toBe(200);
    expect(a.seen.length + b.seen.length).toBe(1);
    a.r.ws.close();
    b.r.ws.close();
  });
});

describe('refusals never reach the runner', () => {
  it('answers 404 with an empty body for unknown, malformed and revoked paths', async () => {
    const m = await createIntegration(w);
    const { r, seen } = await serving(m, () => ({ status: 200 }));
    const unknown = `/relay/in/rly_${'A'.repeat(32)}`;
    for (const path of [
      '/relay/in/',
      '/relay/in',
      '/relay/in/a/b',
      '/relay/in/nope',
      unknown,
      `${unknown}?hub.challenge=1`,
    ]) {
      for (const method of ['GET', 'POST'] as const) {
        const res = await w.t.app.inject({ method, url: path, payload: method === 'POST' ? 'x' : undefined });
        expect([path, method, res.statusCode]).toEqual([path, method, 404]);
        expect(res.body).toBe('');
      }
    }
    // a form post to an unknown token is a 404, not the app's 415
    const form = await post(unknown, 'a=b', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.statusCode).toBe(404);
    // other methods
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const res = await w.t.app.inject({
        method,
        url: m.path,
        payload: method === 'OPTIONS' ? undefined : 'x',
      });
      expect([method, res.statusCode]).toEqual([method, 404]);
    }
    await w.t.req('POST', `/api/relay/integrations/${m.integration.id}/revoke`, { cookie: w.owner.cookie });
    expect((await post(m.path, 'x')).statusCode).toBe(404);
    expect(seen).toHaveLength(0);
    const rows = await relayRows();
    expect(
      rows.every((x) => x.outcome === 'unknown_path' && x.integration_id === null && x.org_id === null),
    ).toBe(true);
    r.ws.close();
  });

  it('answers 404 when the organization is no longer in Business mode', async () => {
    const m = await createIntegration(w);
    await q(`UPDATE organizations SET mode='dev' WHERE id=$1`, [w.owner.id]);
    try {
      expect((await post(m.path, 'x')).statusCode).toBe(404);
    } finally {
      await makeBusiness(w);
    }
  });

  it('answers 413 for a body over the limit, without reaching the runner', async () => {
    const m = await createIntegration(w);
    const { r, seen } = await serving(m, () => ({ status: 200 }));
    const limit = w.t.app.ctx.config.relay.maxBodyBytes;
    expect((await post(m.path, Buffer.alloc(limit))).statusCode).toBe(200);
    const res = await post(m.path, Buffer.alloc(limit + 1));
    expect(res.statusCode).toBe(413);
    expect(res.body).toBe('');
    expect(seen).toHaveLength(1);
    const rows = await relayRows();
    expect(rows.map((x) => x.outcome)).toEqual(['forwarded', 'rejected_size']);
    expect(rows[1]).toMatchObject({ status: 413, integration_id: m.integration.id, size_bytes: limit + 1 });
    r.ws.close();
  });

  it('answers 429 with Retry-After beyond the burst, without reaching the runner', async () => {
    const m = await createIntegration(w);
    const { r, seen } = await serving(m, () => ({ status: 200 }));
    const codes: number[] = [];
    let last: Awaited<ReturnType<typeof post>> | undefined;
    for (let i = 0; i < 5; i++) {
      last = await post(m.path, 'x');
      codes.push(last.statusCode);
    }
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes[3]).toBe(429);
    expect(last?.headers['retry-after']).toMatch(/^\d+$/);
    expect(last?.body).toBe('');
    expect(seen).toHaveLength(3);
    expect((await relayRows()).filter((x) => x.outcome === 'rejected_rate').length).toBeGreaterThanOrEqual(1);
    // another integration has its own bucket
    const other = await createIntegration(w);
    expect((await post(other.path, 'x')).statusCode).toBe(503);
    r.ws.close();
  });

  it('limits each integration on its own: the token bucket refills with time', () => {
    const t0 = 1_000_000;
    const ids = ['a', 'b'];
    for (let i = 0; i < 3; i++) expect(hub().takeToken(ids[0] as string, t0).ok).toBe(true);
    const blocked = hub().takeToken('a', t0);
    expect(blocked.ok).toBe(false);
    expect(hub().takeToken('b', t0).ok).toBe(true);
    expect(hub().takeToken('a', t0 + 1100).ok).toBe(true);
  });
});

describe('runner offline', () => {
  it('answers 503 with Retry-After and an empty body, records only metadata, and queues nothing', async () => {
    const m = await createIntegration(w);
    const res = await post(`${m.path}?secret=1`, 'hello');
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe(String(w.t.app.ctx.config.relay.retryAfterSec));
    expect(res.body).toBe('');
    const rows = await relayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'runner_offline', status: 503, size_bytes: 5, method: 'POST' });
    expect(hub().inFlight).toBe(0);

    // a runner that connects later gets nothing of the earlier calls
    const r = await w.connectRunner();
    const seen = autoReply(r, () => ({ status: 200 }));
    await serve(r, [{ integrationId: m.integration.id, kind: 'generic' }]);
    await r.barrier();
    expect(seen).toHaveLength(0);
    r.ws.close();
  });

  it('answers 503 for a runner that did not announce the integration', async () => {
    const m = await createIntegration(w);
    const r = await w.connectRunner();
    const seen = autoReply(r, () => ({ status: 200 }));
    expect((await post(m.path, 'x')).statusCode).toBe(503);
    expect(seen).toHaveLength(0);
    r.ws.close();
  });

  it('answers 503 at once when the serving runner disconnects while a request waits', async () => {
    const m = await createIntegration(w);
    const { r, seen } = await serving(m, () => null);
    const started = Date.now();
    const pending = post(m.path, 'x');
    await until(async () => seen.length > 0 || null);
    r.ws.close();
    const res = await pending;
    expect(res.statusCode).toBe(503);
    expect(Date.now() - started).toBeLessThan(w.t.app.ctx.config.relay.timeoutMs.generic);
    expect((await relayRows())[0]?.outcome).toBe('runner_offline');
    expect(hub().inFlight).toBe(0);
  });

  it('answers 503 above the in-flight cap', async () => {
    const m = await createIntegration(w);
    const { r } = await serving(m, () => null);
    const cfg = w.t.app.ctx.config.relay;
    const before = cfg.maxInFlight;
    cfg.maxInFlight = 0;
    try {
      expect((await post(m.path, 'x')).statusCode).toBe(503);
    } finally {
      cfg.maxInFlight = before;
    }
    r.ws.close();
  });
});

describe('timeout', () => {
  it('answers 504 when the runner does not answer in time, and ignores a late answer', async () => {
    const m = await createIntegration(w);
    const { r, seen } = await serving(m, () => null);
    const timeouts = w.t.app.ctx.config.relay.timeoutMs;
    const before = timeouts.generic;
    timeouts.generic = 200;
    try {
      const res = await post(m.path, 'x');
      expect(res.statusCode).toBe(504);
      expect(res.body).toBe('');
    } finally {
      timeouts.generic = before;
    }
    expect(hub().inFlight).toBe(0);
    // the late answer: no throw, no second record, nothing in flight
    r.send('relay.response', { requestId: seen[0].requestId, status: 200 });
    r.send('relay.response', { requestId: '0198f2a0-0000-7000-8000-0000000000bb', status: 200 });
    await r.barrier();
    expect(hub().inFlight).toBe(0);
    const rows = await relayRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'timeout', status: 504 });
    r.ws.close();
  });

  it('answers quickly and in order even when slower frames are queued before the answer', async () => {
    const m = await createIntegration(w);
    const { r, seen } = await serving(m, () => null);
    const pending = post(m.path, 'x');
    await until(async () => seen.length > 0 || null);
    for (let i = 0; i < 20; i++)
      r.send('rpc.request', {
        rpcId: crypto.randomUUID(),
        shiftId: crypto.randomUUID(),
        method: 'ledger.search',
        params: {},
      });
    r.send('relay.response', { requestId: seen[0].requestId, status: 204 });
    expect((await pending).statusCode).toBe(204);
    r.ws.close();
  });

  it('ignores an answer from a runner that was not asked', async () => {
    const m = await createIntegration(w);
    const a = await serving(m, () => null);
    const pending = post(m.path, 'x');
    await until(async () => a.seen.length > 0 || null);
    const other = await w.t.userSession(`o-${Date.now()}@example.test`);
    const ws = await pairWorkstation(w.t, other, 'Intruder');
    const intruder = await FakeRunner.connect(w.baseUrl, ws.runnerToken);
    intruder.hello();
    await intruder.waitFor('welcome');
    intruder.send('relay.response', {
      requestId: a.seen[0].requestId,
      status: 200,
      body: Buffer.from('stolen').toString('base64'),
    });
    await intruder.barrier();
    expect(hub().inFlight).toBe(1);
    a.r.send('relay.response', { requestId: a.seen[0].requestId, status: 201 });
    const res = await pending;
    expect(res.statusCode).toBe(201);
    expect(res.body).toBe('');
    intruder.ws.close();
    a.r.ws.close();
  });
});
