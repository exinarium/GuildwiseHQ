import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const me = (cookie: string) => ok<any>(w.t.req('GET', '/api/auth/me', { cookie })).then((r) => r.user.tour);
const put = (cookie: string, body: Record<string, unknown>) =>
  w.t.req('PUT', '/api/auth/tour', { cookie, body });

describe('first-login tour state', () => {
  it('a new user has not seen the tour; progress, skip and completion are kept on the server', async () => {
    const u = await w.t.userSession('tour-new@example.test');
    expect(await me(u.cookie)).toEqual({ status: 'new', step: 0 });

    const mid = await ok<any>(put(u.cookie, { status: 'in_progress', step: 3 }));
    expect(mid.user.tour).toEqual({ status: 'in_progress', step: 3 });
    expect(await me(u.cookie)).toEqual({ status: 'in_progress', step: 3 });

    await ok(put(u.cookie, { status: 'dismissed', step: 3 }));
    expect(await me(u.cookie)).toEqual({ status: 'dismissed', step: 3 });

    // replay, then finish
    await ok(put(u.cookie, { status: 'in_progress', step: 0 }));
    await ok(put(u.cookie, { status: 'completed', step: 9 }));
    expect(await me(u.cookie)).toEqual({ status: 'completed', step: 9 });
  });

  it('a platform administrator can save tour progress too (the platform area has its own tour)', async () => {
    const sa = await w.t.superAdminSession();
    const done = await ok<any>(put(sa.cookie, { status: 'dismissed', step: 2 }));
    expect(done.user.tour).toEqual({ status: 'dismissed', step: 2 });
    expect(await me(sa.cookie)).toEqual({ status: 'dismissed', step: 2 });
  });

  it("one user's tour does not touch another's, and bad input is refused", async () => {
    const a = await w.t.userSession('tour-a@example.test');
    const b = await w.t.userSession('tour-b@example.test');
    await ok(put(a.cookie, { status: 'completed', step: 5 }));
    expect(await me(b.cookie)).toEqual({ status: 'new', step: 0 });
    expect((await put(a.cookie, { status: 'finished', step: 1 })).status).toBe(400);
    expect((await put(a.cookie, { status: 'completed', step: -1 })).status).toBe(400);
    expect((await w.t.req('PUT', '/api/auth/tour', { body: { status: 'completed', step: 1 } })).status).toBe(
      401,
    );
  });

  it('survives a rebuild of the projections, also for a user marked done by the migration', async () => {
    const u = await w.t.userSession('tour-rebuild@example.test');
    await ok(put(u.cookie, { status: 'in_progress', step: 4 }));
    const old = await w.t.userSession('tour-old@example.test');
    // what migration 1321 did to a user who existed before the tour (no event)
    await q("UPDATE users SET tour_status='completed' WHERE id=$1", [old.id]);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await me(u.cookie)).toEqual({ status: 'in_progress', step: 4 });
    expect(await me(old.cookie)).toEqual({ status: 'completed', step: 0 });
  });

  it('with auto-start off a user who never saw the tour counts as done', async () => {
    const cfg = w.t.app.ctx.config;
    cfg.tourAutostart = false;
    try {
      const u = await w.t.userSession('tour-quiet@example.test');
      expect(await me(u.cookie)).toEqual({ status: 'completed', step: 0 });
      // switching it on for one user (what the e2e tour spec does) shows it
      await q("UPDATE users SET tour_status='new' WHERE id=$1", [u.id]);
      expect(await me(u.cookie)).toEqual({ status: 'new', step: 0 });
      // an explicit start is honoured
      await ok(put(u.cookie, { status: 'in_progress', step: 0 }));
      expect(await me(u.cookie)).toEqual({ status: 'in_progress', step: 0 });
    } finally {
      cfg.tourAutostart = true;
    }
  });
});
