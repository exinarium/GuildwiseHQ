import { afterEach, describe, expect, it } from 'vitest';
import { IpcServer, type ShiftIpcHandler } from '../src/ipc/server.ts';

const servers: IpcServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const handler: ShiftIpcHandler = {
  report: async (r) => ({ accepted: true, message: `ok ${r.report.kind}` }),
  rpc: async (r) => ({ ok: true, result: { method: r.method } }),
};

async function start() {
  const s = new IpcServer();
  servers.push(s);
  await s.start();
  return s;
}
const post = (url: string, path: string, token: string | undefined, body: unknown) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

describe('ipc server', () => {
  it('binds 127.0.0.1 on an ephemeral port and accepts the current shift token', async () => {
    const s = await start();
    expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const token = s.registerShift(handler);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const r = await post(s.url, '/v1/report', token, { report: { kind: 'comment', note: 'hi' } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ accepted: true, message: 'ok comment' });
    const rpc = await post(s.url, '/v1/rpc', token, { method: 'card.get' });
    expect(await rpc.json()).toEqual({ ok: true, result: { method: 'card.get' } });
  });

  it('rejects requests without a token, with a wrong token, and after the shift ends', async () => {
    const s = await start();
    const token = s.registerShift(handler);
    const body = { report: { kind: 'comment', note: 'hi' } };
    expect((await post(s.url, '/v1/report', undefined, body)).status).toBe(401);
    expect((await post(s.url, '/v1/report', 'wrong', body)).status).toBe(401);
    expect((await post(s.url, '/v1/rpc', undefined, { method: 'card.get' })).status).toBe(401);
    s.revoke(token);
    expect((await post(s.url, '/v1/report', token, body)).status).toBe(401);
  });

  it('tokens are per shift', async () => {
    const s = await start();
    const seen: string[] = [];
    const a = s.registerShift({
      ...handler,
      report: async () => {
        seen.push('a');
        return { accepted: true, message: 'a' };
      },
    });
    const b = s.registerShift({
      ...handler,
      report: async () => {
        seen.push('b');
        return { accepted: true, message: 'b' };
      },
    });
    await post(s.url, '/v1/report', b, { report: { kind: 'comment', note: 'x' } });
    await post(s.url, '/v1/report', a, { report: { kind: 'comment', note: 'x' } });
    expect(seen).toEqual(['b', 'a']);
  });

  it('validates bodies and maps handler statuses', async () => {
    const s = await start();
    const token = s.registerShift({
      ...handler,
      report: async () => ({ status: 501, error: 'later' }),
    });
    expect((await post(s.url, '/v1/report', token, { nope: 1 })).status).toBe(400);
    const r = await post(s.url, '/v1/report', token, { report: { kind: 'comment', note: 'x' } });
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({ error: 'later' });
    expect((await post(s.url, '/v1/other', token, {})).status).toBe(404);
  });
});
