import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/** The value report (backlog #37): finished cards, estimated human hours, usage, return, trend, next actions, settings, CSV. */
let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const orgId = async (): Promise<string> =>
  (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;

/** A card of the given type, forced to done at the given time. */
async function doneCard(cardType: string, at: string, rework = 0): Promise<string> {
  const c = await w.card({ title: `value ${randomUUID().slice(0, 5)}`, cardType });
  await q(`UPDATE cards SET status='done', finalized_at=$2, created_at=$3, rework_round=$4 WHERE id=$1`, [
    c.id,
    at,
    new Date(new Date(at).getTime() - 2 * 86_400_000),
    rework,
  ]);
  return c.id;
}
async function addSpend(usdMicros: number, endedAt: string) {
  const agent = (await q(`SELECT id FROM agents LIMIT 1`))[0]?.id ?? null;
  if (!agent) {
    await w.hire('Vera', 'builder', 'junior', { model: 'claude-sonnet-4-5', capacity: 1 });
    return addSpend(usdMicros, endedAt);
  }
  await q(
    `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, kind, model, cost_usd_micros, ended_at)
     VALUES ($1, $2, $3, $4, 'card', 'sonnet', $5, $6)`,
    [randomUUID(), await orgId(), agent, w.projectId, usdMicros, endedAt],
  );
}

describe('value report', () => {
  it('counts the month, estimates hours by card type, sets them against usage and shows the trend', async () => {
    await doneCard('feature', '2026-09-10T10:00:00Z', 1);
    await doneCard('bug', '2026-09-11T10:00:00Z');
    await doneCard('bug', '2026-09-30T23:30:00Z');
    await doneCard('docs', '2026-08-15T10:00:00Z');
    await doneCard('feature', '2026-10-01T08:00:00Z'); // another month
    await addSpend(7_000_000, '2026-09-12T10:00:00Z');
    await addSpend(1_000_000, '2026-08-12T10:00:00Z');

    const r = await ok<any>(owner('GET', '/api/value?month=2026-09'));
    expect(r.current).toMatchObject({
      month: '2026-09',
      cards: 3,
      hours: 14, // feature 8 + bug 3 + bug 3
      usageMicros: 7_000_000,
      valueMicros: 560_000_000, // 14 h x $40
      returnX: 80,
      reworkRounds: 1,
    });
    expect(r.current.avgDaysToDone).toBe(2);
    expect(r.previous).toMatchObject({ month: '2026-08', cards: 1, hours: 2, usageMicros: 1_000_000 });
    expect(r.byType).toEqual(
      expect.arrayContaining([
        { cardType: 'feature', cards: 1, hours: 8 },
        { cardType: 'bug', cards: 2, hours: 6 },
      ]),
    );
    expect(r.byProject[0]).toMatchObject({
      key: expect.any(String),
      cards: 3,
      hours: 14,
      usageMicros: 7_000_000,
    });
    expect(r.settings).toMatchObject({ canEdit: true, hourlyValue: null, hourlyValueEffective: 40 });
  });

  it('has no return figure when nothing was spent, and counts zero cards in an empty month', async () => {
    const r = await ok<any>(owner('GET', '/api/value?month=2025-01'));
    expect(r.current).toMatchObject({
      cards: 0,
      hours: 0,
      usageMicros: 0,
      returnX: null,
      avgDaysToDone: null,
    });
  });

  it('lists stuck cards as next actions', async () => {
    const c = await w.card({ title: 'Stuck one' });
    await q(`UPDATE cards SET status='blocked', updated_at = now() - interval '6 days' WHERE id=$1`, [c.id]);
    const r = await ok<any>(owner('GET', '/api/value'));
    const stuck = r.nextActions.find((a: any) => a.kind === 'stuck_card' && a.title.includes('Stuck one'));
    expect(stuck).toMatchObject({ ref: c.ref });
    expect(stuck.detail).toContain('6 days');
  });

  it('lists an agent that fails often', async () => {
    const agent = (await q(`SELECT id FROM agents LIMIT 1`))[0]?.id;
    const ws = w.workstationId;
    const card = (await q(`SELECT id FROM cards LIMIT 1`))[0]?.id;
    for (let i = 0; i < 4; i++)
      await q(
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, status, outcome, runtime, model, started_at, ended_at, duration_ms)
         VALUES ($1,$2,$3,$4,$5,'card','ended','crashed','claude','sonnet', now() - interval '1 day', now() - interval '1 day', 1000)`,
        [randomUUID(), await orgId(), agent, ws, card],
      );
    const r = await ok<any>(owner('GET', '/api/value'));
    expect(r.nextActions.find((a: any) => a.kind === 'failing_agent')?.detail).toMatch(
      /4 of 4 shifts failed/,
    );
  });

  it('exports a CSV with a row per project and the totals', async () => {
    const res = await owner('GET', '/api/value/export.csv?month=2026-09');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('aom-value-2026-09.csv');
    const lines = String(res.body).trim().split('\n');
    expect(lines[0]).toBe('month,project,cards_done,est_human_hours,usage_USD,return_x');
    expect(lines.at(-1)).toBe('2026-09,TOTAL,3,14,7.00,80');
  });

  it('lets an Owner or Admin adjust the estimates, survives a rebuild, and refuses a member', async () => {
    const r = await ok<any>(
      owner('PUT', '/api/value/settings', { hoursByType: { feature: 10, bug: 1 }, hourlyValue: 50 }),
    );
    expect(r.settings).toMatchObject({ hourlyValue: 50, hourlyValueEffective: 50 });
    expect(r.settings.hoursByType).toMatchObject({ feature: 10, bug: 1, docs: 2 });
    const sep = await ok<any>(owner('GET', '/api/value?month=2026-09'));
    expect(sep.current.hours).toBe(12); // 10 + 1 + 1
    expect(sep.current.valueMicros).toBe(600_000_000);

    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    // (the forced "done" cards above are SQL edits a rebuild replays away; the settings come from their event)
    const again = await ok<any>(owner('GET', '/api/value'));
    expect(again.settings).toMatchObject({ hourlyValue: 50 });
    expect(again.settings.hoursByType).toMatchObject({ feature: 10, bug: 1 });

    const m = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(await orgId(), m.id, 'member');
    const headers = { 'x-aom-org': await orgId() };
    expect((await w.t.req('GET', '/api/value', { cookie: m.cookie, headers })).status).toBe(403);
    expect(
      (
        await w.t.req('PUT', '/api/value/settings', {
          cookie: m.cookie,
          headers,
          body: { hoursByType: {}, hourlyValue: null },
        })
      ).status,
    ).toBe(403);
    await ok(owner('PUT', '/api/value/settings', { hoursByType: {}, hourlyValue: null }));
  });
});
