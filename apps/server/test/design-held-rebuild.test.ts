import { READONLY_DESIGN_CAPABILITY, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectScope, SYSTEM_ACTOR } from '../src/commands/common.ts';
import { migrateDesignHeldStatus } from '../src/data-migrations/design-held-status.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, eventsOfType, pipeline } from './helpers/pipeline.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, fullFields, until, type World } from './helpers/world.ts';

// A held design (status 'held') survives a full projection rebuild, is released by replay when its dependency
// landed, and the legacy-repair data migration is idempotent and replay-safe. Own file: a rebuild replays every
// agent, so the world must not be reset with freshState between tests.

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [READONLY_DESIGN_CAPABILITY] });
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const append = async (id: string, type: string, payload: Record<string, unknown>) => {
  const org = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
  await seed(w, [
    {
      streamId: streamId.card(id),
      event: { type, payload: { cardId: id, ...payload } },
      actor: SYSTEM_ACTOR,
      scope: projectScope(org, w.projectId),
    },
  ]);
};
const rebuild = async () => {
  await w.t.app.ctx.notifier.flush();
  await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
};

describe('held design: replay', () => {
  it('a rebuild keeps it held, releases it once the dependency landed, and the repair migration is idempotent', async () => {
    await q(`UPDATE project_repos SET main_branch=NULL, working_branch=NULL WHERE id=$1`, [w.repoId]);
    await q(`UPDATE projects SET design_step=true, investigation_location='repo' WHERE id=$1`, [w.projectId]);
    await w.hire('Aria', 'architect', 'senior');
    const base = await w.card({
      title: 'Base',
      designNeeded: false,
      fields: fullFields({ context: 'x', requirements: 'y' }),
    });
    await q(`UPDATE cards SET status='blocked' WHERE id=$1`, [base.id]);
    const dep = await w.card({ title: 'Dependent', designNeeded: true, dependencies: [base.id] });
    const start = await p.next('Aria');
    r.accepted(start.shiftId);
    r.started(start.shiftId);
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
      3000,
      'shift running',
    );
    const res = await p.report(r, start.shiftId, {
      kind: 'outcome',
      outcomeId: 'handoff',
      note: 'designed',
      data: {
        reportPath: 'docs/investigations/d.md',
        summary: 'Build it.',
        location: 'repo',
        body: '# d',
        assumptions: [{ assumption: 'a', dependency: base.ref, ifWrong: 'b' }],
      },
    });
    expect(res).toMatchObject({ accepted: true });
    r.ended(start.shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
      3000,
      'shift ended',
    );
    const state = async () =>
      (await q('SELECT status, stage, design_review FROM cards WHERE id=$1', [dep.id]))[0];
    const held = await state();
    expect(held!.status).toBe('held');

    await rebuild();
    expect(await state()).toEqual(held);

    // legacy repair: projected queued, then the migration holds it once
    await q(`UPDATE cards SET status='queued' WHERE id=$1`, [dep.id]);
    const env = {
      pool: w.t.app.ctx.pool,
      store: w.t.app.ctx.store,
      clock: w.t.app.ctx.clock,
      log: () => {},
    } as any;
    await q(`DELETE FROM data_migrations WHERE name='design-held-status-2026-10'`);
    expect((await migrateDesignHeldStatus(env))!.confirmed).toEqual([{ ref: dep.ref }]);
    expect((await cardRow(dep.id)).status).toBe('held');
    expect(await migrateDesignHeldStatus(env)).toBeNull();
    await q(`DELETE FROM data_migrations WHERE name='design-held-status-2026-10'`);
    expect((await migrateDesignHeldStatus(env))!.confirmed).toEqual([]);
    expect((await eventsOfType('DesignHoldConfirmed')).filter((e) => e.cardId === dep.id)).toHaveLength(1);
    await rebuild();
    expect(await state()).toEqual(held);

    // the dependency lands: released, and a rebuild gives the same
    await append(base.id, 'CardMergeVerified', { workingBranch: 'main', manual: true });
    const released = await state();
    expect(released!.status).toBe('queued');
    expect(released!.design_review).toMatchObject({ state: 'waiting' });
    await rebuild();
    expect(await state()).toEqual(released);
  });
});
