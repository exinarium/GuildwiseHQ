import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

/** Operational columns are excluded from the comparison (docs/PLAN.md M1.2). */
const OPERATIONAL: Record<string, string[]> = {
  users: ['last_login_at'],
  workstations: ['connected', 'last_seen_at', 'runtimes', 'hostname', 'platform', 'runner_version'],
  cards: ['lease_expires_at'],
  shifts: ['progress_tail', 'accepted_at'],
  card_transitions: ['id'],
};

async function snapshot(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of PROJECTION_TABLES) {
    const drop = (OPERATIONAL[table] ?? []).map((c) => ` - '${c}'`).join('');
    const rows = await q(`SELECT (to_jsonb(t)${drop})::text AS j FROM "${table}" t`);
    out[table] = rows.map((r) => r.j as string).sort();
  }
  return out;
}

describe('projections:rebuild', () => {
  it('yields identical projection tables for a database produced by real flows', async () => {
    const r = await w.connectRunner();
    await w.hire('Una', 'builder', 'junior');
    const rev = await w.hire('Val', 'reviewer', 'senior');
    const keep = await w.card({
      title: 'Reviewed',
      fields: {
        context: 'c',
        requirements: 'r',
        acceptanceCriteria: ['a'],
        affectedAreas: 'x',
        constraints: 'y',
        testPlan: 't',
        mock: { review: ['changes'] },
      },
    });
    await w.card({ title: 'Draft only', specify: false });
    const cancelled = await w.card({ title: 'To cancel' });
    await ok(
      w.t.req('POST', `/api/cards/${cancelled.id}/cancel`, {
        cookie: w.owner.cookie,
        body: { reason: 'nope' },
      }),
    );
    await ok(
      w.t.req('POST', `/api/cards/${keep.id}/comments`, {
        cookie: w.owner.cookie,
        body: { body: 'a comment' },
      }),
      201,
    );
    await w.t.req('PATCH', `/api/cards/${keep.id}`, {
      cookie: w.owner.cookie,
      body: { priority: 3, fields: { constraints: 'changed' } },
    });

    // build -> review -> changes -> (rework claimed by Una again)
    const dispatcher = w.t.app.ctx.services.dispatcher;
    await dispatcher.run();
    let start = await r.waitFor('shift.start', (f) => f.brief.card.ref === 'TOY-1');
    r.accepted(start.shiftId);
    r.started(start.shiftId, {
      path: '/wt/TOY-1',
      branchName: 'aom/toy-1',
      baseBranch: 'main',
      created: true,
      headSha: 'a',
    });
    r.send('shift.progress', {
      shiftId: start.shiftId,
      items: [{ at: new Date().toISOString(), kind: 'text', text: 'working' }],
    });
    const rep = r.report(
      start.shiftId,
      { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: {} },
      { diffStats: { files: 1, added: 10, removed: 0, architecturalPaths: [] }, riskTier: 'small' },
    );
    await r.waitFor('shift.report.result', (f) => f.reportId === rep.reportId);
    r.ended(start.shiftId);
    const from = r.received.length;
    await dispatcher.run();
    start = await r.waitFor('shift.start', (f) => f.agent.name === 'Val', 5000, from);
    r.accepted(start.shiftId);
    r.started(start.shiftId);
    const rep2 = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'changes',
      note: 'redo',
      data: { score: 2, reasons: ['weak_tests'] },
    });
    await r.waitFor('shift.report.result', (f) => f.reportId === rep2.reportId);
    r.ended(start.shiftId);
    await until(async () => (await q(`SELECT 1 FROM shifts WHERE status <> 'ended'`)).length === 0, 3000);
    await dispatcher.run(); // rework claimed -> a live claim at snapshot time
    await ok(w.t.req('POST', `/api/agents/${rev.id}/fire`, { cookie: w.owner.cookie }));
    await w.t.app.ctx.notifier.flush();

    const sessionsBefore = (await q('SELECT count(*)::int AS n FROM auth_sessions'))[0]!.n;
    const reposBefore = (await q('SELECT count(*)::int AS n FROM workstation_repos'))[0]!.n;
    const commandsBefore = await q('SELECT id, status FROM runner_commands ORDER BY id');
    const before = await snapshot();
    expect(before.cards).toHaveLength(3);
    expect(before.card_handoffs).toHaveLength(2);
    expect(before.card_transitions!.length).toBeGreaterThan(8);
    expect(before.thread_messages!.length).toBeGreaterThanOrEqual(4);
    expect(before.agents).toHaveLength(2);
    expect(before.workflow_stages!.length).toBeGreaterThan(10);

    const res = await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(res.events).toBeGreaterThan(30);

    expect(await snapshot()).toEqual(before);
    // operational tables survive the rebuild
    expect((await q('SELECT count(*)::int AS n FROM auth_sessions'))[0]!.n).toBe(sessionsBefore);
    expect((await q('SELECT count(*)::int AS n FROM workstation_repos'))[0]!.n).toBe(reposBefore);
    expect(await q('SELECT id, status FROM runner_commands ORDER BY id')).toEqual(commandsBefore);
    expect((await q('SELECT connected FROM workstations'))[0]!.connected).toBe(true);
    // the live claim's lease is recomputed from the claim time
    const claimed = await q(`SELECT claimed_at, lease_expires_at FROM cards WHERE claim_id IS NOT NULL`);
    for (const c of claimed)
      expect(new Date(c.lease_expires_at).getTime() - new Date(c.claimed_at).getTime()).toBe(3600_000);
    r.close();
  });
});
