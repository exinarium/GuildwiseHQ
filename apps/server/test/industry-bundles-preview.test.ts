import { rulePackById } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// GWP-233: the bundle preview flags an own rule that says the same as a pack rule. A world of its own, so no state
// from the install and uninstall cases can stand in for the own rule.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  await q(`UPDATE organizations SET mode='business' WHERE id=$1`, [w.owner.id]);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const as = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) });
const eventCount = async () => Number((await q('SELECT count(*)::int AS n FROM events'))[0]?.n);

describe('industry bundle preview', () => {
  it('flags a near-duplicate of the organization own rule, and writes nothing', async () => {
    const rule = rulePackById('law')?.rules[0];
    if (!rule) throw new Error('no rule');
    const before = await ok<any>(as('GET', '/api/industry-bundles/law'));
    expect(before.rulePack.rules.find((r: any) => r.id === rule.id).status).toBe('new');

    const made = await as('POST', '/api/ledger', {
      scope: 'standing_order',
      title: rule.title,
      body: rule.body,
    });
    expect([200, 201], JSON.stringify(made.body)).toContain(made.status);

    const events = await eventCount();
    const pv = await ok<any>(as('GET', '/api/industry-bundles/law'));
    const first = pv.rulePack.rules.find((r: any) => r.id === rule.id);
    expect(['covered', 'may_conflict']).toContain(first.status);
    expect(await eventCount()).toBe(events);
  });
});
