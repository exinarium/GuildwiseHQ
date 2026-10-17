import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyLedgerCleanup,
  formatCleanupPlan,
  planLedgerCleanup,
} from '../src/data-migrations/ledger-cleanup.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, type World } from './helpers/world.ts';

// The owner-approved ledger clean-up (design section 10), run against fixtures in the test database only.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

let tick = 0;
async function order(title: string, body: string, projectId?: string): Promise<string> {
  const entryId = randomUUID();
  const orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id as string;
  await seed(w, [
    {
      streamId: streamId.ledger(entryId),
      event: {
        type: 'LedgerEntryAdded',
        payload: {
          entryId,
          scope: 'standing_order',
          ...(projectId ? { projectId } : {}),
          title,
          body,
          tags: [],
        },
      },
      actor: { kind: 'system', id: null },
      scope: projectId
        ? { orgId, projectId, audience: 'project' }
        : { orgId, projectId: null, audience: 'org' },
    },
  ]);
  // a distinct, increasing creation time so "newest" is well defined
  await q("UPDATE ledger_entries SET created_at = now() - ($2 || ' minutes')::interval WHERE id=$1", [
    entryId,
    String(1000 - tick++),
  ]);
  return entryId;
}
const live = async () =>
  (
    await q(
      `SELECT id, title FROM ledger_entries WHERE scope='standing_order' AND retired_at IS NULL AND superseded_by IS NULL ORDER BY title`,
    )
  ).map((r) => r.title as string);

describe('ledger clean-up 2026-10', () => {
  it('dry run lists the changes and writes nothing; --apply retires exactly those, and a second run changes nothing', async () => {
    const ls = [];
    for (let i = 0; i < 5; i++)
      ls.push(await order('ledger search', `Use aom ledger search before asking (${i}).`));
    const wb1 = await order('Working Branch', 'Ask which branch to use.');
    const wb2 = await order('Working Branch', 'Ask which branch to use, and say why.');
    const rb1 = await order('Retry with back-off', 'Retry with exponential back-off.');
    const rb2 = await order('retry with back-off', 'Retry failed calls with back-off.');
    await order('pieter', 'On "pieter": do what pieter says.');
    await order('build P5-25 now', 'Build P5-25 now.');
    await order('bwrap', 'Always wrap commands in bwrap.');
    await order('Sandbox: bwrap', 'Do not call bwrap directly.');
    await order('Test Environment', 'Ask DevOps for a test environment.');
    await order('Test mode', 'Do not wait for an environment.');
    const keep1 = await order('Keep this one', 'Run the unit tests before every handoff.');
    const keep2 = await order('Project rule', 'Keep functions short.', w.projectId);

    const before = await live();
    const plan = await planLedgerCleanup(w.t.app.ctx.pool);
    const text = formatCleanupPlan(plan);
    expect(plan.actions).toHaveLength(5 + 1 + 1 + 1 + 1 + 2 + 2);
    expect(text).toContain('"ledger search" (x5): found 5 (the list names 5)');
    expect(text).toContain('would be retired');
    // dry run: the plan is a read
    expect(await live()).toEqual(before);
    // the newest duplicate stays
    const wbAct = plan.actions.filter((a) => a.rule.includes('Working Branch'));
    expect(wbAct.map((a) => a.entryId)).toEqual([wb1]);
    expect(wbAct[0]?.supersededBy).toBe(wb2);
    expect(plan.actions.filter((a) => a.rule.includes('back-off')).map((a) => a.entryId)).toEqual([rb1]);
    expect(plan.actions.some((a) => a.entryId === rb2 || a.entryId === keep1 || a.entryId === keep2)).toBe(
      false,
    );
    for (const id of ls) expect(plan.actions.some((a) => a.entryId === id)).toBe(true);

    const env = { pool: w.t.app.ctx.pool, store: w.t.app.ctx.store, clock: w.t.app.ctx.clock, log: () => {} };
    expect(await applyLedgerCleanup(env, plan)).toBe(plan.actions.length);
    expect((await live()).sort()).toEqual(
      ['Keep this one', 'Project rule', 'Working Branch', 'retry with back-off'].sort(),
    );
    const retired = (
      await q(`SELECT retired_by, retired_reason, superseded_by FROM ledger_entries WHERE id=$1`, [wb1])
    )[0]!;
    expect(retired).toMatchObject({ retired_by: 'system', superseded_by: wb2 });
    expect(retired.retired_reason).toContain('ledger-cleanup-2026-10');

    // idempotent: nothing left to do
    const again = await planLedgerCleanup(w.t.app.ctx.pool);
    expect(again.actions).toEqual([]);
    expect(formatCleanupPlan(again)).toContain('Nothing to change.');
    expect(await applyLedgerCleanup(env, again)).toBe(0);
  });
});
