import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdminPool } from './helpers/db.ts';
import { manualWorld } from './helpers/pr-review-manual.ts';

/** GWP-201 AC3: only the owner triggers. Needs the test database (127.0.0.1:5433). */

let m: Awaited<ReturnType<typeof manualWorld>>;

beforeAll(async () => {
  m = await manualWorld();
});
afterAll(async () => {
  m.r.close();
  await m.w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await m.clean();
});

describe('AC3: a non-owner is refused', () => {
  it('a project member gets 403, nothing is appended or enqueued, and sees no action', async () => {
    const pr = await m.addPr();
    await m.addRun(pr, { state: 'timed_out', code: 'timeout' });
    const member = await m.addMember('manager');
    const eventsBefore = (await m.db().query('SELECT count(*)::int AS n FROM events')).rows[0].n;
    const res = await m.trigger(pr, undefined, member.cookie);
    expect(res.status).toBe(403);
    expect((await m.db().query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(eventsBefore);
    expect(await m.runCommands()).toBe(0);
    expect(await m.runs(pr)).toHaveLength(1);
    // the member can still read the list, with no action; the owner sees one
    const seen = await m.prOf(pr, member.cookie);
    expect(seen).toBeTruthy();
    expect(seen.manualAction).toBeNull();
    expect((await m.prOf(pr)).manualAction).toMatchObject({ kind: 'rerun' });
  });

  it('a user who is not a member of the project gets 404', async () => {
    const pr = await m.addPr();
    const stranger = await m.w.t.userSession(`stranger-${randomUUID().slice(0, 6)}@example.test`);
    const res = await m.trigger(pr, undefined, stranger.cookie);
    expect(res.status).toBe(404);
    expect(await m.runs(pr)).toHaveLength(0);
  });

  it('the project owner is allowed', async () => {
    const pr = await m.addPr();
    expect((await m.trigger(pr)).status).toBe(200);
  });
});
