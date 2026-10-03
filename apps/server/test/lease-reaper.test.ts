import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_TEST_CLOCK: 'true' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const reaper = () => w.t.app.ctx.services.reaper;

describe('reaper', () => {
  it('marks a workstation disconnected after 45 s without a heartbeat and closes its socket', async () => {
    const r = await w.connectRunner();
    expect((await q('SELECT connected FROM workstations'))[0]!.connected).toBe(true);
    w.t.clock.advance(46_000);
    await reaper().run();
    expect((await q('SELECT connected FROM workstations'))[0]!.connected).toBe(false);
    expect((await r.waitClosed()).code).toBe(4408);
    w.t.clock.setOffset(0);
  });

  it('sends shift.stop(timeout) once a shift overruns maxShiftMinutes + 10 min', async () => {
    const r = await w.connectRunner();
    await w.hire('Timo', 'builder', 'junior');
    await w.card({ title: 'Overrun' });
    await w.t.app.ctx.services.dispatcher.run();
    const s = await r.waitFor('shift.start');
    r.accepted(s.shiftId);
    r.started(s.shiftId);
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [s.shiftId]))[0],
    );
    w.t.clock.advance(60 * 60_000 + 11 * 60_000 - 5 * 60_000);
    r.heartbeat([s.shiftId]); // keeps the lease alive
    await until(
      async () =>
        new Date((await q('SELECT last_seen_at FROM workstations'))[0]!.last_seen_at).getTime() >
        w.t.clock.now().getTime() - 5000,
    );
    await reaper().run();
    expect(r.of('shift.stop')).toHaveLength(0);
    w.t.clock.advance(6 * 60_000);
    r.heartbeat([s.shiftId]);
    await until(
      async () =>
        new Date((await q('SELECT last_seen_at FROM workstations'))[0]!.last_seen_at).getTime() >
        w.t.clock.now().getTime() - 5000,
    );
    await reaper().run();
    const stop = await r.waitFor('shift.stop');
    expect(stop).toMatchObject({ shiftId: s.shiftId, reason: 'timeout' });
    w.t.clock.setOffset(0);
    r.close();
  });
});

describe('test clock endpoint', () => {
  it('advances the server clock (AOM_TEST_CLOCK) without needing an Origin header', async () => {
    const before = await ok<any>(
      w.t.app
        .inject({ method: 'POST', url: '/api/test/clock', payload: { advanceMs: 3600_000 } })
        .then((r) => ({ status: r.statusCode, body: r.json() })),
    );
    expect(before.offsetMs).toBeGreaterThanOrEqual(3600_000);
    const reset = await ok<any>(w.t.req('POST', '/api/test/clock', { body: { offsetMs: 0 } }));
    expect(reset.offsetMs).toBe(0);
  });

  it('is not available unless enabled', async () => {
    const { createTestApp } = await import('./helpers/app.ts');
    await w.t.close();
    const t2 = await createTestApp({ reset: false });
    try {
      expect((await t2.req('POST', '/api/test/clock', { body: { advanceMs: 1 } })).status).toBe(404);
    } finally {
      await t2.close();
    }
    w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' }, listen: false });
  });
});
