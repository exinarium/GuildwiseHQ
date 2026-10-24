import {
  costUsdMicros,
  isCostUnknown,
  SESSION_TURNS_CAPABILITY,
  SESSION_VERBS_CAPABILITY,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * Owner-set model prices (R2): the Owner prices a model the tables do not know; its session turns are costed with that price,
 * marked owner-priced and not "unknown"; a later change never reprices a past turn; a rebuild gives the same rows.
 */
const q = async (sql: string, params: unknown[] = []): Promise<any[]> => rawQ(sql, params) as Promise<any[]>;
let w: World;
let r: FakeRunner;
let orgId: string;
let admin: { id: string; cookie: string };
const seen = new Set<string>();
const MODEL = 'openai-compatible:llama3-local';

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY] });
  admin = await w.t.userSession(uniqueEmail('admin'));
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  await w.t.addOrgMember(orgId, admin.id, 'admin');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );

/** One finished turn of a new discovery session, billed on MODEL. */
async function turn(): Promise<string> {
  const s = (await owner('POST', '/api/discovery', { title: 'Prices', idea: 'Local models' }, 201)).state;
  const start = await r.waitFor(
    'chat.start',
    (x) => !seen.has(x.chatId) && x.threadId === s.threadId,
    15_000,
  );
  seen.add(start.chatId);
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: 'ok',
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: MODEL,
    },
  });
  await until(
    async () => (await q('SELECT 1 FROM shift_costs WHERE shift_id=$1', [start.chatId])).length === 1,
  );
  return start.chatId;
}
const costRow = async (id: string) => (await q('SELECT * FROM shift_costs WHERE shift_id=$1', [id]))[0];

describe('the shared cost function', () => {
  const owner1 = [
    { provider: 'openai-compatible', model: 'x', inputPerMtok: 1, outputPerMtok: 3, cacheReadPerMtok: 0.5 },
  ];
  it('fills gaps only: an unknown model gets the Owner price, a listed one keeps its own', () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };
    expect(isCostUnknown('openai-compatible:x')).toBe(true);
    expect(isCostUnknown('openai-compatible:x', undefined, owner1)).toBe(false);
    expect(costUsdMicros('openai-compatible:x', u, undefined, owner1)).toBe(4_500_000);
    const listed = [
      {
        provider: 'openai',
        model: 'gpt-5-mini',
        inputPerMtok: 99,
        outputPerMtok: 99,
        cacheReadPerMtok: null,
      },
    ];
    expect(costUsdMicros('openai:gpt-5-mini', u, undefined, listed)).toBe(
      costUsdMicros('openai:gpt-5-mini', u),
    );
    expect(costUsdMicros('openai-compatible:x', u)).toBe(0);
  });
});

describe('owner-set model prices', () => {
  it('flags a turn on an unpriced model as unknown', async () => {
    const id = await turn();
    const row = await costRow(id);
    expect(row.cost_unknown).toBe(true);
    expect(row.owner_priced).toBe(false);
    expect(Number(row.cost_usd_micros)).toBe(0);
  });

  it('only the Owner may set or remove a price; Admins may read', async () => {
    const body = {
      provider: 'openai-compatible',
      model: 'llama3-local',
      inputPerMtok: 0.2,
      outputPerMtok: 0.6,
      cacheReadPerMtok: null,
    };
    expect(
      (
        await w.t.req('PUT', '/api/org/model-prices', {
          cookie: admin.cookie,
          headers: { 'x-aom-org': orgId },
          body,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await w.t.req('GET', '/api/org/model-prices', {
          cookie: admin.cookie,
          headers: { 'x-aom-org': orgId },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await w.t.req('PUT', '/api/org/model-prices', {
          cookie: w.owner.cookie,
          body: { ...body, inputPerMtok: -1 },
        })
      ).status,
    ).toBe(400);
    await owner('PUT', '/api/org/model-prices', body);
    const list = await owner('GET', '/api/org/model-prices');
    expect(list.prices).toMatchObject([
      { provider: 'openai-compatible', model: 'llama3-local', inputPerMtok: 0.2 },
    ]);
  });

  it('costs later turns with the price, marks them owner-priced, and never reprices earlier ones', async () => {
    const before = (await q(`SELECT shift_id FROM shift_costs WHERE kind='session'`))[0].shift_id as string;
    const id = await turn();
    const row = await costRow(id);
    // 1M in at $0.2 + 0.5M out at $0.6 = $0.50
    expect(Number(row.cost_usd_micros)).toBe(500_000);
    expect(row.owner_priced).toBe(true);
    expect(row.cost_unknown).toBe(false);
    expect(Number((await costRow(before)).cost_usd_micros)).toBe(0);
    // changing the price affects the next turn only
    await owner('PUT', '/api/org/model-prices', {
      provider: 'openai-compatible',
      model: 'llama3-local',
      inputPerMtok: 1,
      outputPerMtok: 1,
      cacheReadPerMtok: null,
    });
    expect(Number((await costRow(id)).cost_usd_micros)).toBe(500_000);
    const id2 = await turn();
    expect(Number((await costRow(id2)).cost_usd_micros)).toBe(1_500_000);
  });

  it('a rebuild gives the same cost rows and prices', async () => {
    const snap = async () =>
      JSON.parse(
        JSON.stringify([
          await q(
            `SELECT shift_id, cost_usd_micros, cost_unknown, owner_priced, cost_stamped FROM shift_costs WHERE kind='session' ORDER BY shift_id`,
          ),
          await q(
            'SELECT provider, model, input_per_mtok, output_per_mtok FROM org_model_prices ORDER BY model',
          ),
        ]),
      );
    const before = await snap();
    expect(PROJECTION_TABLES).toContain('org_model_prices');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await snap()).toEqual(before);
  });

  it('removing a price makes new turns unknown again', async () => {
    await ok(
      w.t.req('DELETE', '/api/org/model-prices?provider=openai-compatible&model=llama3-local', {
        cookie: w.owner.cookie,
      }),
      200,
    );
    const id = await turn();
    expect((await costRow(id)).cost_unknown).toBe(true);
    expect((await owner('GET', '/api/org/model-prices')).prices).toEqual([]);
  });
});
