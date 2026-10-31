import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { autoReply, createIntegration, makeBusiness, serve } from './helpers/relay.ts';
import { createWorld, type World } from './helpers/world.ts';

/**
 * The relay stores and logs nothing of an event's content. Sentinel strings in the path token, the query, a header value
 * and the body travel through every outcome; then the whole database and every captured log line are searched for them.
 */
const lines: string[] = [];
const logStream = { write: (line: string) => void lines.push(line) };

let w: World;
beforeAll(async () => {
  w = await createWorld({
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_RELAY_RATE_BURST: '2', LOG_LEVEL: 'trace' },
    logStream,
  });
  await makeBusiness(w);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const S = {
  body: 'SENTINEL_BODY_7f3a91c2',
  header: 'SENTINEL_HEADER_5be04d68',
  query: 'SENTINEL_QUERY_c81d27e0',
  path: 'SENTINEL_PATH_a94f6b13',
  answer: 'SENTINEL_ANSWER_2d6e8f40',
};

const dump = async (): Promise<string> => {
  const tables = await q<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`,
  );
  const parts: string[] = [];
  for (const { table_name } of tables)
    parts.push(JSON.stringify(await q(`SELECT t::text AS r FROM "${table_name}" t`)));
  return parts.join('\n');
};

describe('no content in the database or the logs', () => {
  it('keeps none of the sentinels, through every outcome', async () => {
    const m = await createIntegration(w, 'generic', 'Shop');
    const token = m.path.replace('/relay/in/', '');
    const send = (path: string, payload: Buffer | string = S.body) =>
      w.t.app.inject({
        method: 'POST',
        url: `${path}?q=${S.query}&hub.verify_token=${S.query}`,
        payload,
        headers: {
          'content-type': 'application/json',
          'x-secret-header': S.header,
          authorization: `Bearer ${S.header}`,
        },
      });
    const outcomes: number[] = [];

    // offline
    outcomes.push((await send(m.path)).statusCode);

    // forwarded
    const r = await w.connectRunner();
    let answer = true;
    autoReply(r, () => (answer ? { status: 200, body: S.answer } : null));
    await serve(r, [{ integrationId: m.integration.id, kind: 'generic' }]);
    outcomes.push((await send(m.path)).statusCode);

    // 429: the burst is two, and the offline 503 used one
    outcomes.push((await send(m.path)).statusCode);
    outcomes.push((await send(m.path)).statusCode);

    // timeout
    const other = await createIntegration(w, 'webhook_in', 'Hook');
    answer = false;
    const timeouts = w.t.app.ctx.config.relay.timeoutMs;
    const before = timeouts.webhook_in;
    timeouts.webhook_in = 150;
    await serve(r, [
      { integrationId: m.integration.id, kind: 'generic' },
      { integrationId: other.integration.id, kind: 'webhook_in' },
    ]);
    try {
      outcomes.push((await send(other.path)).statusCode);
    } finally {
      timeouts.webhook_in = before;
    }

    // 413
    outcomes.push(
      (await send(other.path, Buffer.alloc(w.t.app.ctx.config.relay.maxBodyBytes + 1, 'x'))).statusCode,
    );

    // 404: unknown token carrying the path sentinel, malformed paths, and a revoked one
    outcomes.push((await send(`/relay/in/rly_${S.path}`)).statusCode);
    outcomes.push((await send(`/relay/in/${S.path}/${S.path}`)).statusCode);
    const gone = await createIntegration(w, 'generic', 'Gone');
    await w.t.req('POST', `/api/relay/integrations/${gone.integration.id}/revoke`, {
      cookie: w.owner.cookie,
    });
    outcomes.push((await send(gone.path)).statusCode);

    expect(outcomes).toEqual([503, 200, 429, 429, 504, 413, 404, 404, 404]);

    // an invalid frame from the runner must not echo its values either
    r.send('relay.response', { requestId: S.body, status: 200, body: S.answer });
    r.send('relay.response', {
      requestId: '0198f2a0-0000-7000-8000-0000000000cc',
      status: 999,
      body: S.answer,
    });
    await r.barrier();
    await w.t.app.ctx.notifier.flush();

    // the sentinels exist where they should: the log capture works and the table dump is real
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('relay request'))).toBe(true);
    const rows = await q('SELECT outcome FROM relay_requests ORDER BY id');
    expect(new Set(rows.map((x) => x.outcome))).toEqual(
      new Set(['runner_offline', 'forwarded', 'rejected_rate', 'timeout', 'rejected_size', 'unknown_path']),
    );

    const db = await dump();
    const logs = lines.join('\n');
    for (const [name, sentinel] of Object.entries(S)) {
      expect([name, 'database', db.includes(sentinel)]).toEqual([name, 'database', false]);
      expect([name, 'logs', logs.includes(sentinel)]).toEqual([name, 'logs', false]);
    }
    // the plain token: not in a table, not in a log line (the hash is)
    expect(db.includes(token)).toBe(false);
    expect(logs.includes(token)).toBe(false);
    expect(db.includes(m.url)).toBe(false);
    r.ws.close();
  });
});
