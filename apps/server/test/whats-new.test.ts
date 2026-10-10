import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const seen = (cookie: string) =>
  ok<any>(w.t.req('GET', '/api/auth/me', { cookie })).then((r) => r.user.whatsNewSeen);
const mark = (cookie: string, body: Record<string, unknown>) =>
  w.t.req('PUT', '/api/auth/whats-new-seen', { cookie, body });

describe("what's new seen state", () => {
  it('starts empty, accumulates without duplicates, and is per user', async () => {
    const a = await w.t.userSession('wn-a@example.test');
    const b = await w.t.userSession('wn-b@example.test');
    expect(await seen(a.cookie)).toEqual([]);
    const r = await ok<any>(mark(a.cookie, { entryIds: ['2026-10-10-x', 'b'] }));
    expect(r.user.whatsNewSeen).toEqual(['2026-10-10-x', 'b']);
    await ok(mark(a.cookie, { entryIds: ['b', 'c'] }));
    expect(await seen(a.cookie)).toEqual(['2026-10-10-x', 'b', 'c']);
    expect(await seen(b.cookie)).toEqual([]);
  });

  it('refuses bad input and anonymous callers', async () => {
    const a = await w.t.userSession('wn-bad@example.test');
    expect((await mark(a.cookie, { entryIds: [] })).status).toBe(400);
    expect((await mark(a.cookie, { entryIds: ['has space'] })).status).toBe(400);
    expect((await w.t.req('PUT', '/api/auth/whats-new-seen', { body: { entryIds: ['a'] } })).status).toBe(
      401,
    );
  });

  it('survives a rebuild of the projections', async () => {
    const a = await w.t.userSession('wn-rebuild@example.test');
    await ok(mark(a.cookie, { entryIds: ['one', 'two'] }));
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await seen(a.cookie)).toEqual(['one', 'two']);
  });

  it('works for a platform administrator too', async () => {
    const sa = await w.t.superAdminSession();
    await ok(mark(sa.cookie, { entryIds: ['p'] }));
    expect(await seen(sa.cookie)).toEqual(['p']);
  });
});
