import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signHook } from '../src/journeys/hooks/signature.ts';
import { journeyTick } from '../src/journeys/tick.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Inbound journey hooks (docs/investigations/GWP-67 §4.4): signature on the raw bytes, 401 without a trace of the payload,
 * start on a new or matched record, resume of a webhook wait, and no payload content in tables or logs.
 */
const lines: string[] = [];
const logStream = { write: (line: string) => void lines.push(line) };
let w: World;
let journeyId = '';
const asOwner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), expected);

const S = { body: 'SENTINEL_BODY_41c7aa09', header: 'SENTINEL_HEADER_9d02e5b7', other: 'SENTINEL_OTHER_6a1f3c88' };
const dump = async (): Promise<string> => {
  const tables = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
  );
  const parts: string[] = [];
  for (const { table_name } of tables) parts.push(JSON.stringify(await q(`SELECT t::text AS r FROM "${table_name}" t`)));
  return parts.join('\n');
};

const newHook = async (over: Record<string, unknown> = {}, jid = journeyId) =>
  (await asOwner(
    'POST',
    `/api/journeys/${jid}/hooks`,
    { name: 'Intake', purpose: 'start', mapping: { externalId: '/id', displayName: '/name' }, ...over },
    201,
  )) as { id: string; url: string; secret: string };
const tokenOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);
const post = (
  h: { url: string; secret: string },
  payload: unknown,
  opts: { scheme?: 'guildwise' | 'body_sha256'; ts?: number; headers?: Record<string, string>; sign?: boolean; type?: string } = {},
) => {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const sig = opts.sign === false ? {} : signHook(opts.scheme ?? 'guildwise', h.secret, raw, opts.ts ?? Math.floor(w.t.clock.now().getTime() / 1000));
  return w.t.app.inject({
    method: 'POST',
    url: `/hooks/in/${tokenOf(h.url)}`,
    payload: raw,
    headers: { 'content-type': opts.type ?? 'application/json', ...sig, ...(opts.headers ?? {}) },
  });
};
const calls = async (hookId: string) => (await q('SELECT * FROM journey_hook_calls WHERE trigger_id=$1 ORDER BY at, id', [hookId])) as any[];

beforeAll(async () => {
  process.env.AOM_JOURNEY_HOOK_BURST = '6';
  w = await createWorld({ env: { LOG_LEVEL: 'trace' }, logStream });
  journeyId = (
    await asOwner(
      'POST',
      '/api/journeys',
      {
        projectId: w.projectId,
        definition: {
          name: 'Intake',
          recordType: 'client',
          firstStepId: 'a',
          steps: [{ kind: 'wait', id: 'a', label: 'A' }],
          handoffs: [],
        },
      },
      201,
    )
  ).id;
});
afterAll(async () => {
  delete process.env.AOM_JOURNEY_HOOK_BURST;
  await w.t.close();
  await closeAdminPool();
});

describe('inbound hook start', () => {
  it('a valid signature starts a journey on a new record in the trigger creator’s name', async () => {
    const h = await newHook();
    const r = await post(h, { id: 'K-1', name: 'Kim', extra: S.body });
    expect(r.statusCode).toBe(202);
    const body = r.json();
    expect(body.matched).toBe(false);
    const inst = (await q('SELECT * FROM journey_instances WHERE id=$1', [body.instanceId]))[0] as any;
    expect(inst.started_by).toBe(w.owner.id);
    const rec = (await q('SELECT * FROM journey_records WHERE id=$1', [body.recordId]))[0] as any;
    expect(rec).toMatchObject({ external_id: 'K-1', display_name: 'Kim' });
    expect((await calls(h.id))[0]).toMatchObject({ status: 202, outcome: 'started' });
  });

  it('a second call for a record that has a running journey is 409 record_busy', async () => {
    const h = await newHook();
    expect((await post(h, { id: 'K-2', name: 'Lee' })).statusCode).toBe(202);
    const again = await post(h, { id: 'K-2', name: 'Lee' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('record_busy');
  });

  it('matches an existing record by external id', async () => {
    await asOwner('POST', '/api/journeys', { projectId: w.projectId, definition: { name: 'T', recordType: 'client', firstStepId: 'a', steps: [{ kind: 'wait', id: 'a', label: 'A' }], handoffs: [] } }, 201);
    const rec = await ok<any>(
      w.t.req('POST', '/api/journey-instances', {
        cookie: w.owner.cookie,
        body: { journeyId, record: { type: 'client', displayName: 'Existing', externalId: 'K-3' } },
      }),
      201,
    );
    await asOwner('POST', `/api/journey-instances/${rec.id}/cancel`, {});
    const h = await newHook();
    const r = await post(h, { id: 'K-3', name: 'Other name' });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ matched: true, recordId: rec.recordId });
  });

  it('two records with the same external id are 422 ambiguous_record', async () => {
    for (let i = 0; i < 2; i++)
      await ok(w.t.req('POST', '/api/journey-instances', { cookie: w.owner.cookie, body: { journeyId, record: { type: 'client', displayName: `D${i}`, externalId: 'DUP' } } }), 201);
    const r = await post(await newHook(), { id: 'DUP' });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('ambiguous_record');
  });

  it('on_no_match refuse answers 422 no_record and creates nothing', async () => {
    const h = await newHook({ onNoMatch: 'refuse' });
    const r = await post(h, { id: 'NOPE-1' });
    expect(r.statusCode).toBe(422);
    expect((await q(`SELECT 1 FROM journey_records WHERE external_id='NOPE-1'`)).length).toBe(0);
  });

  it('a repeated idempotency key answers 200 and starts nothing', async () => {
    const h = await newHook();
    const first = await post(h, { id: 'IDEM-1', name: 'I' }, { headers: { 'idempotency-key': 'abc-1' } });
    expect(first.statusCode).toBe(202);
    const second = await post(h, { id: 'IDEM-1', name: 'I' }, { headers: { 'idempotency-key': 'abc-1' } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true, instanceId: first.json().instanceId });
    expect((await q(`SELECT 1 FROM journey_records WHERE external_id='IDEM-1'`)).length).toBe(1);
  });

  it('the body_sha256 scheme (GitHub style) works', async () => {
    const h = await newHook({ scheme: 'body_sha256' });
    expect((await post(h, { id: 'GH-1' }, { scheme: 'body_sha256' })).statusCode).toBe(202);
  });
});

describe('refusals', () => {
  it('a wrong, missing or stale signature is 401 and logged without the payload', async () => {
    const h = await newHook();
    const bad = await post({ ...h, secret: 'jhsec_wrong' }, { id: 'X-1', extra: S.body });
    const none = await post(h, { id: 'X-2', extra: S.body }, { sign: false });
    const stale = await post(h, { id: 'X-3', extra: S.body }, { ts: Math.floor(w.t.clock.now().getTime() / 1000) - 3600 });
    expect([bad.statusCode, none.statusCode, stale.statusCode]).toEqual([401, 401, 401]);
    expect(bad.body).toBe('');
    expect((await calls(h.id)).map((c) => c.outcome)).toEqual(['bad_signature', 'bad_signature', 'stale_timestamp']);
    expect((await q(`SELECT 1 FROM journey_records WHERE external_id LIKE 'X-%'`)).length).toBe(0);
  });

  it('wrong content type is 415, a malformed JSON is 400, a pointer that leads nowhere is 422, an unknown token is 404', async () => {
    const h = await newHook();
    expect((await post(h, '{}', { type: 'text/plain' })).statusCode).toBe(415);
    expect((await post(h, '{not json')).statusCode).toBe(400);
    expect((await post(h, { other: 1 })).statusCode).toBe(422);
    const unknown = await w.t.app.inject({ method: 'POST', url: `/hooks/in/${'A'.repeat(32)}`, payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(unknown.statusCode).toBe(404);
    expect((await w.t.app.inject({ method: 'POST', url: '/hooks/in/short', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(404);
  });

  it('a body over the limit is 413', async () => {
    const h = await newHook();
    const r = await post(h, Buffer.alloc(70_000, 'x'));
    expect(r.statusCode).toBe(413);
  });

  it('the rate limit answers 429 with Retry-After', async () => {
    const h = await newHook();
    const codes: number[] = [];
    let retry: unknown;
    for (let i = 0; i < 9; i++) {
      const r = await post(h, { id: `RATE-${i}` });
      codes.push(r.statusCode);
      if (r.statusCode === 429) retry = r.headers['retry-after'];
    }
    expect(codes).toContain(429);
    expect(Number(retry)).toBeGreaterThan(0);
  });

  it('a disabled trigger and a rotated token answer 404', async () => {
    const h = await newHook();
    await asOwner('PATCH', `/api/journeys/${journeyId}/hooks/${h.id}`, { enabled: false });
    expect((await post(h, { id: 'D-1' })).statusCode).toBe(404);
    const g = await newHook();
    const r = await asOwner('POST', `/api/journeys/${journeyId}/hooks/${g.id}/rotate`, {});
    expect((await post(g, { id: 'R-1' })).statusCode).toBe(404);
    expect((await post(r, { id: 'R-1' })).statusCode).toBe(202);
  });
});

describe('webhook waits resume', () => {
  it('a signed call resumes the wait on the matched record', async () => {
    const resume = await newHook({ purpose: 'resume', name: 'Docs received' });
    const waiting = await asOwner(
      'POST',
      '/api/journeys',
      {
        projectId: w.projectId,
        definition: {
          name: 'Waiter',
          recordType: 'client',
          firstStepId: 'a',
          steps: [
            { kind: 'wait', id: 'a', label: 'A', waitFor: { kind: 'webhook', triggerId: resume.id }, duration: { amount: 1, unit: 'days' }, onTimeout: { action: 'cancel' } },
            { kind: 'wait', id: 'after', label: 'After' },
          ],
          handoffs: [{ id: 'h1', from: 'a', on: 'done', to: 'after' }],
        },
      },
      201,
    );
    const inst = await ok<any>(
      w.t.req('POST', '/api/journey-instances', {
        cookie: w.owner.cookie,
        body: { journeyId: waiting.id, record: { type: 'client', displayName: 'Res', externalId: 'RES-1' } },
      }),
      201,
    );
    await journeyTick(w.t.app.ctx, { projectId: w.projectId });
    const none = await post(resume, { id: 'UNKNOWN' });
    expect(none.statusCode).toBe(422);
    const r = await post(resume, { id: 'RES-1' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ resumed: 1 });
    const wait = (await q('SELECT * FROM journey_waits WHERE instance_id=$1', [inst.id]))[0] as any;
    expect(wait).toMatchObject({ status: 'resolved', resolution: 'webhook_received' });
    expect(((await q('SELECT * FROM journey_instances WHERE id=$1', [inst.id]))[0] as any).current_step_id).toBe('after');
    const again = await post(resume, { id: 'RES-1' });
    expect(again.json()).toEqual({ resumed: 0 });
  });
});

describe('no content in the database or the logs', () => {
  it('keeps none of the sentinels except the values the mapping picked', async () => {
    const h = await newHook();
    const send = (id: string, name: string, over: Record<string, unknown> = {}) =>
      post(h, { id, name, secretField: S.body, nested: { deep: S.other } }, { headers: { 'x-secret-header': S.header, authorization: `Bearer ${S.header}`, ...over } });
    await send('SC-1', 'Sam');
    await post({ ...h, secret: 'jhsec_wrong' }, { id: 'SC-2', secretField: S.body }, { headers: { 'x-secret-header': S.header } });
    await post(h, { secretField: S.body }, { headers: { 'x-secret-header': S.header } });
    await post(h, `{${S.body}`, { headers: { 'x-secret-header': S.header } });
    await w.t.app.ctx.notifier.flush();
    expect(lines.length).toBeGreaterThan(0);
    const db = await dump();
    const logs = lines.join('\n');
    for (const [name, sentinel] of Object.entries(S)) {
      expect([name, 'database', db.includes(sentinel)]).toEqual([name, 'database', false]);
      expect([name, 'logs', logs.includes(sentinel)]).toEqual([name, 'logs', false]);
    }
    expect(logs).not.toContain(tokenOf(h.url));
    expect(db).not.toContain(h.secret);
  });
});
