import { DESK_SUBKIND } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * uat-runner-fixes-3 Rework 2 (R2-S1): when the runner refused a DevOps shift's change in a card worktree but could not undo
 * all of it, the owner gets a desk alert (the violation on the shift alone reached nobody who can act).
 */

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const alerts = () =>
  q(`SELECT * FROM desk_items WHERE subkind=$1 ORDER BY created_at`, [DESK_SUBKIND.devopsCardWorktree]);

async function devopsShift() {
  const from = r.received.length;
  await ok<any>(
    w.t.req('POST', `/api/workstations/${w.workstationId}/hygiene/run`, { cookie: w.owner.cookie }),
    201,
  );
  await w.t.app.ctx.services.dispatcher.run();
  const start = await r.waitFor('shift.start', (f) => f.kind === 'devops', 5000, from);
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
    3000,
    'devops shift running',
  );
  return start.shiftId as string;
}

async function end(shiftId: string, detail: string) {
  r.ended(shiftId, 'no_report', { guardViolations: [{ rule: 'devops_card_worktree', detail }] });
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [shiftId, 'ended']))[0],
    5000,
    'shift ended',
  );
  await w.t.app.ctx.notifier.flush();
}

describe('a card worktree change the runner could not fully undo reaches the owner', () => {
  it('fully reverted: no alert; NOT fully reverted: one alert with the runner account', async () => {
    const a = await devopsShift();
    await end(a, 'The DevOps engineer changed a card worktree ... /w/TOY-1: HEAD moved (reverted)');
    expect(await alerts()).toHaveLength(0);
    await q(`UPDATE devops_requests SET status='done' WHERE status IN ('queued','running')`);

    const b = await devopsShift();
    await end(
      b,
      'The DevOps engineer changed a card worktree ... /w/TOY-1: ignored files that existed before were changed: node_modules/ (NOT fully reverted: check it)',
    );
    const items = await alerts();
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('alert');
    expect(items[0]?.status).toBe('open');
    expect(items[0]?.body).toContain('node_modules/');
    expect(items[0]?.body).toContain('/w/TOY-1');
    expect(items[0]?.title).toContain('check it by hand');
  });
});

describe('T9 follow-up: a DevOps shift put back on a usage limit or an expired login still raises the alert', () => {
  it.each(['usage_limited', 'auth_expired'] as const)(
    '%s with a NOT fully reverted violation: one alert',
    async (reason) => {
      await q(`UPDATE devops_requests SET status='done' WHERE status IN ('queued','running')`);
      const before = (await alerts()).length;
      // a rejection cools the agent down for 30 s; the next case needs it at once
      w.t.app.ctx.services.dispatcher.cooldown.clear();
      const shiftId = await devopsShift();
      r.send('shift.rejected', {
        shiftId,
        reason,
        detail: 'put back',
        // already over, so the next case still gets a shift dispatched (auth_expired runs last)
        ...(reason === 'usage_limited' ? { limitedUntil: new Date(Date.now() - 1000).toISOString() } : {}),
        guardViolations: [
          {
            rule: 'devops_card_worktree',
            detail: `The DevOps engineer changed a card worktree ... /w/TOY-${reason}: x (NOT fully reverted: check it)`,
          },
        ],
      });
      await until(async () => (await alerts()).length === before + 1, 5000, 'alert');
      expect((await alerts()).at(-1)?.body).toContain(`/w/TOY-${reason}`);
    },
  );
});
