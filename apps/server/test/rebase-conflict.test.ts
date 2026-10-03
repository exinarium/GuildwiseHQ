import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, eventsOfType, hireTeam, pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

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

describe('rebase conflict', () => {
  it('a conflicting rebase before test sends the card to Rework with the files listed; no agent resolves it', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Conflicting change' });
    await p.toTest('Bea', ['Rex']);

    const start = await p.reject('Tess', 'rebase_conflict', {
      detail: 'rebase conflict in src/a.ts, src/b.ts',
      conflictedFiles: ['src/a.ts', 'src/b.ts'],
    });
    expect(start.prepare.rebase).toBe(true);

    expect(await cardRow(card.id)).toMatchObject({
      stage: 'build',
      status: 'queued',
      rework_round: 1,
      claim_id: null,
    });
    const ev = (await eventsOfType('RebaseConflict')).filter((e) => e.cardId === card.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ stage: 'test', conflictedFiles: ['src/a.ts', 'src/b.ts'] });

    const d = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    const msg = d.thread.find((m: any) => m.data?.conflictedFiles);
    expect(msg.body).toContain('- src/a.ts');
    expect(msg.body).toContain('- src/b.ts');
    const cols = (
      await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }))
    ).columns;
    expect(cols.find((c: any) => c.name === 'Rework').cards.map((c: any) => c.ref)).toContain(card.ref);

    // only a builder can pick it up (the tester and reviewer cannot): the original builder is routed first
    const made = await w.t.app.ctx.services.dispatcher.runPass();
    const mine = made.filter((m) => m.cardId === card.id);
    expect(mine).toHaveLength(1);
    const agent = await q('SELECT role_key FROM agents WHERE id=$1', [mine[0]?.agentId]);
    expect(agent[0]?.role_key).toBe('builder');
  });
});
