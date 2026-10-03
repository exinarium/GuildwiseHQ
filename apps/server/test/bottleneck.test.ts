import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, eventsOfType, pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const desk = async () =>
  (await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }))).items.filter(
    (i: any) => i.subkind === 'tester_bottleneck',
  );
const age = (id: string, minutes: number) =>
  q(`UPDATE cards SET queued_at = now() - ($2 || ' minutes')::interval WHERE id=$1`, [id, String(minutes)]);

describe('tester bottleneck alert', () => {
  it('a single pinned alert appears once E2E work waited 5 minutes with every tester busy', async () => {
    await freshState();
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
    const a = await w.card({ title: 'First' });
    const b = await w.card({ title: 'Second' });
    await p.toTest('Bea', ['Rex']);
    await p.toTest('Bea', ['Rex']);
    await w.hire('Tess', 'tester', 'junior');
    // Tess takes the first card and keeps it (capacity 1), the second waits
    const start = await p.next('Tess');
    await p.startShift(r, start);
    const waiting = start.brief.card.ref === a.ref ? b : a;
    await age(waiting.id, 2);
    await w.t.app.ctx.services.dispatcher.runPass();
    expect(await desk()).toHaveLength(0);

    await age(waiting.id, 6);
    await w.t.app.ctx.services.dispatcher.runPass();
    await w.t.app.ctx.services.dispatcher.runPass();
    const items = await desk();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'alert',
      pinned: true,
      blocking: false,
      projectId: w.projectId,
      recommendation: 'hire_tester',
      affectedCardIds: [waiting.id],
    });
    expect(items[0].options[0].label).toMatch(/hire a tester/i);
    const ev = await eventsOfType('TesterBottleneck');
    expect(ev.at(-1)).toMatchObject({ projectId: w.projectId, recommendation: { hire: 'tester', count: 1 } });
    expect(ev.at(-1).busyTesterIds).toHaveLength(1);

    // finishing and draining the queue resolves the alert by itself
    const pass = { kind: 'outcome', outcomeId: 'pass', note: 'ok', data: { summary: 'ok' } };
    await p.report(r, start.shiftId, pass);
    r.ended(start.shiftId, 'reported');
    const second = await p.next('Tess');
    await p.startShift(r, second);
    await p.report(r, second.shiftId, pass);
    r.ended(second.shiftId, 'reported');
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [second.shiftId]))[0],
      3000,
      'ended',
    );
    await w.t.app.ctx.services.dispatcher.runPass();
    expect(await desk()).toHaveLength(0);
    const all = await q(`SELECT status FROM desk_items WHERE subkind='tester_bottleneck'`);
    expect(all.map((d) => d.status)).toEqual(['answered']);
    expect(await cardRow(a.id)).toBeTruthy();
  });

  it('does not alert while a tester is free, and recommends a hire when none exists', async () => {
    await freshState();
    await q(`DELETE FROM desk_items WHERE subkind='tester_bottleneck'`);
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
    const card = await w.card({ title: 'No tester yet' });
    await p.toTest('Bea', ['Rex']);
    await age(card.id, 10);
    await w.t.app.ctx.services.dispatcher.runPass();
    const items = await desk();
    expect(items).toHaveLength(1);
    expect(items[0].body).toMatch(/No tester is hired/);
  });
});
