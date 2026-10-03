import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, eventsOfType, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, markOnline, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
beforeEach(() => w.t.app.ctx.clock.setOffset(0));
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const regressionSchedule = (platform: string, over: Record<string, unknown> = {}) =>
  w.t.req('POST', '/api/schedules', {
    cookie: w.owner.cookie,
    body: {
      projectId: w.projectId,
      name: 'Nightly regression',
      kind: 'regression',
      cron: '0 2 * * *',
      timezone: 'UTC',
      cardTemplate: { title: 'Nightly regression', fields: { platform } },
      ...over,
    },
  });

/** Heartbeat after the clock moved; keeps the workstation's repo so repo cards stay claimable. */
async function online() {
  const repoIds = (await q('SELECT id FROM project_repos WHERE project_id=$1', [w.projectId])).map(
    (x) => x.id,
  );
  await markOnline(w.t, w.workstationId, { repoIds });
}

/** Moves the test clock past the schedule's next fire and runs the scheduler once. */
async function fireSchedule(nextFireAt: string) {
  w.t.app.ctx.clock.setOffset(new Date(nextFireAt).getTime() - Date.now() + 1000);
  return w.t.app.ctx.services.scheduler.run();
}

describe('regression schedules (M5 scheduler -> M4 regression run)', () => {
  it('a due regression schedule creates scheduled regression cards per platform that a tester claims', async () => {
    await freshState();
    await hireTeam(w);
    const s = await ok<any>(regressionSchedule('both'), 201);
    const fired = await fireSchedule(s.nextFireAt);
    expect(fired).toHaveLength(1);
    await online();

    const cards = await q(`SELECT * FROM cards WHERE origin='regression' ORDER BY number`);
    expect(cards.map((c) => [c.card_type, c.stage, c.status, c.scheduled, c.fields.platform])).toEqual([
      ['regression', 'test', 'queued', true, 'web'],
      ['regression', 'test', 'queued', true, 'mobile'],
    ]);
    const ev = (await eventsOfType('RegressionRequested')).at(-1);
    expect(ev).toMatchObject({ platform: 'both', projectId: w.projectId });
    expect(ev.regressionCardIds).toHaveLength(2);
    const sch = (await q('SELECT last_card_id, last_fired_at FROM schedules WHERE id=$1', [s.id]))[0]!;
    expect(sch.last_card_id).toBe(cards[0]!.id);
    expect(sch.last_fired_at).not.toBeNull();

    const run = await p.run('Tess', testPass('web regression green'));
    expect(run.start.brief.card.cardType).toBe('regression');
    expect(run.start.brief.card.fields.platform).toBe('web');
    expect(await cardRow(cards[0]!.id)).toMatchObject({ stage: 'done', status: 'done' });
    expect(await q(`SELECT kind, platform, result FROM test_runs`)).toEqual([
      { kind: 'regression', platform: 'web', result: 'passed' },
    ]);
    // The mobile card is claimed next; running it also leaves no stale shift.start behind for later tests.
    const mobile = await p.run('Tess', testPass('mobile regression green'));
    expect(mobile.start.brief.card.fields.platform).toBe('mobile');
  });

  it('rejects a regression schedule with an unknown platform', async () => {
    await ok(regressionSchedule('desktop'), 400);
  });
});

describe('overflow is one rule for M4 suite cards and M5 scheduled cards', () => {
  it('a late suite card and a late scheduled regression card share a single overflow shift per organization', async () => {
    await freshState();
    await hireTeam(w);
    // A feature card passes its test and is finalized; the suite card appears once the command result arrives.
    const done = await w.card({ title: 'Shipped feature' });
    await p.toTest('Bea', ['Rex']);
    await p.run('Tess', testPass());
    const from = r.received.length;
    await ok(w.t.req('POST', `/api/cards/${done.id}/finalize`, { cookie: w.owner.cookie, body: {} }));
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);

    // The only tester becomes busy with normal work before the suite card exists.
    const busyCard = await w.card({ title: 'Normal feature work' });
    await p.toTest('Bea', ['Rex']);
    const busy = await p.next('Tess');
    await p.startShift(r, busy);
    expect(busy.brief.card.ref).toBe(busyCard.ref);

    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, action: 'merge', mergeCommit: 'a1b2c3d' },
    });
    await until(async () => (await cardRow(done.id)).status === 'done', 3000, 'finalized');
    const suite = (await q(`SELECT * FROM cards WHERE origin='full_suite'`))[0]!;
    expect(suite.scheduled).toBe(true);

    // A scheduled regression comes due as well: two late scheduled cards, one busy tester.
    const s = await ok<any>(regressionSchedule('web'), 201);
    expect(await fireSchedule(s.nextFireAt)).toHaveLength(1);
    await online();
    await q(`UPDATE cards SET queued_at = $1 WHERE scheduled AND status='queued'`, [
      new Date(w.t.app.ctx.clock.now().getTime() - 120_000),
    ]);

    const first = await w.t.app.ctx.services.dispatcher.runPass();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ overflow: true, agentId: busy.agent.agentId });
    // One extra shift at a time: the other late scheduled card waits.
    expect(await w.t.app.ctx.services.dispatcher.runPass()).toEqual([]);
    const overflowing = await q(
      `SELECT ref, origin FROM cards WHERE claim_overflow AND claim_id IS NOT NULL`,
    );
    expect(overflowing).toHaveLength(1);
    const waiting = await q(`SELECT origin FROM cards WHERE scheduled AND status='queued'`);
    expect(waiting).toHaveLength(1);
    expect(new Set([overflowing[0]!.origin, waiting[0]!.origin])).toEqual(
      new Set(['full_suite', 'regression']),
    );
  });
});
