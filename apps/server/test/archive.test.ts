import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, fullFields, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const cookie = () => w.owner.cookie;
const hoursAgo = (h: number) => new Date(w.t.clock.now().getTime() - h * 3_600_000);
const board = async () =>
  (
    await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: cookie() }))
  ).columns.flatMap((c: any) => c.cards.map((x: any) => x.ref)) as string[];
const archive = async (qs = '', c = cookie()) =>
  ok<any>(w.t.req('GET', `/api/archive?projectId=${w.projectId}${qs}`, { cookie: c }));
const card = (title: string, externalRef?: string) =>
  w.card({ title, fields: fullFields(externalRef ? { externalRef } : {}) });
/** Finish a card as the projection would, `hours` ago. */
const finish = async (id: string, status: 'done' | 'cancelled', hours: number) => {
  const at = hoursAgo(hours);
  await q(
    `UPDATE cards SET status=$2, stage=CASE WHEN $2 = 'done' THEN 'done' ELSE stage END, updated_at=$3 WHERE id=$1`,
    [id, status, at],
  );
  expect((await q('SELECT finished_at FROM cards WHERE id=$1', [id]))[0]?.finished_at).toEqual(at);
};

describe('archive: done cards leave the board after a day (#51)', () => {
  it('stamps finished_at when a card finishes and clears it when it comes back', async () => {
    const c = await card('Stamp me');
    expect((await q('SELECT finished_at FROM cards WHERE id=$1', [c.id]))[0]?.finished_at).toBeNull();
    await finish(c.id, 'done', 3);
    await q(`UPDATE cards SET status='queued', stage='build', updated_at=$2 WHERE id=$1`, [
      c.id,
      hoursAgo(1),
    ]);
    expect((await q('SELECT finished_at FROM cards WHERE id=$1', [c.id]))[0]?.finished_at).toBeNull();
  });

  it('keeps a card finished less than 24 hours ago on the board and moves older ones to the archive', async () => {
    const fresh = await card('Finished just now');
    const old = await card('Finished two days ago', 'ABC-7');
    const cancelled = await card('Cancelled long ago');
    await finish(fresh.id, 'done', 2);
    await finish(old.id, 'done', 48);
    await finish(cancelled.id, 'cancelled', 72);

    const onBoard = await board();
    expect(onBoard).toContain(fresh.ref);
    expect(onBoard).not.toContain(old.ref);
    expect(onBoard).not.toContain(cancelled.ref);

    const a = await archive();
    expect(a).toMatchObject({ afterHours: 24, projectId: w.projectId });
    const refs = a.cards.map((x: any) => x.ref);
    expect(refs).toContain(old.ref);
    expect(refs).toContain(cancelled.ref);
    expect(refs).not.toContain(fresh.ref);
    // newest finished first
    expect(refs.indexOf(old.ref)).toBeLessThan(refs.indexOf(cancelled.ref));
    expect(a.cards.find((x: any) => x.ref === old.ref)).toMatchObject({
      status: 'done',
      externalRef: 'ABC-7',
      title: 'Finished two days ago',
    });
  });

  it('searches by ref, title and ticket key, and filters by status and date', async () => {
    const old = (await archive('&q=two%20days')).cards[0];
    expect(old.title).toBe('Finished two days ago');
    expect((await archive(`&q=${old.ref}`)).cards.map((x: any) => x.ref)).toEqual([old.ref]);
    expect((await archive('&q=ABC-7')).cards.map((x: any) => x.ref)).toEqual([old.ref]);
    expect((await archive('&q=%25')).cards).toEqual([]); // % is literal
    expect((await archive('&status=cancelled')).cards.map((x: any) => x.title)).toEqual([
      'Cancelled long ago',
    ]);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    // one calendar day (UTC) holding the card finished 48 h ago; the 72 h card is a day earlier at any time of day
    const inRange = await archive(`&from=${day(hoursAgo(48))}&to=${day(hoursAgo(48))}`);
    expect(inRange.cards.map((x: any) => x.title)).toEqual(['Finished two days ago']);
    expect((await archive(`&from=${day(hoursAgo(1))}`)).cards).toEqual([]);
  });

  it('pages the list', async () => {
    const p1 = await archive('&pageSize=1&page=1');
    const p2 = await archive('&pageSize=1&page=2');
    expect(p1.total).toBe(2);
    expect(p1.cards).toHaveLength(1);
    expect(p2.cards).toHaveLength(1);
    expect(p1.cards[0].ref).not.toBe(p2.cards[0].ref);
    expect((await archive('&pageSize=1&page=3')).cards).toEqual([]);
  });

  it('filters by the agent that handed the card over', async () => {
    const old = (await archive('&q=two%20days')).cards[0];
    const agent = await w.hire('Archie', 'builder', 'junior');
    await q(
      `INSERT INTO card_handoffs (id, card_id, shift_id, agent_id, stage, outcome, note, data, event_seq, created_at)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 'build', 'done', 'x', '{}'::jsonb, 1, now())`,
      [old.id, agent.id],
    );
    const mine = await archive(`&agentId=${agent.id}`);
    expect(mine.cards.map((x: any) => x.ref)).toEqual([old.ref]);
    expect(mine.cards[0].lastAgent).toBe('Archie');
  });

  it('is not visible to someone outside the project', async () => {
    const stranger = await w.t.userSession(uniqueEmail('archive'));
    const res = await w.t.req('GET', `/api/archive?projectId=${w.projectId}`, { cookie: stranger.cookie });
    expect([403, 404]).toContain(res.status);
  });

  it('an archived card still opens, and reopening it puts it back on the board', async () => {
    const old = (await archive('&q=two%20days')).cards[0];
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${old.id}`, { cookie: cookie() }));
    expect(detail.card.status).toBe('done');
    expect(detail.permissions.canReopen).toBe(true);
    await ok(
      w.t.req('POST', `/api/cards/${old.id}/reopen`, {
        cookie: cookie(),
        body: { toStage: 'build', reason: 'one more thing' },
      }),
    );
    expect(await board()).toContain(old.ref);
    expect((await archive()).cards.map((x: any) => x.ref)).not.toContain(old.ref);
    expect((await q('SELECT finished_at FROM cards WHERE id=$1', [old.id]))[0]?.finished_at).toBeNull();
  });
});
