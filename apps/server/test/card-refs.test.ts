import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool } from './helpers/db.ts';
import { addMember, type Member } from './helpers/members.ts';
import { createWorld, fullFields, ok, type World } from './helpers/world.ts';

let w: World;
let b: Member;
let ownCardId: string;
let sharedCardId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  b = await addMember(w, 'twin');
  // B also owns a project with the same key (keys are unique per organization only)
  const own = await ok<any>(
    w.t.req('POST', '/api/projects', { cookie: b.cookie, body: { key: 'TOY', name: 'Twin toy' } }),
    201,
  );
  const mk = async (projectId: string, cookie: string) =>
    (
      await ok<any>(
        w.t.req('POST', '/api/cards', {
          cookie,
          body: {
            projectId,
            title: 'Same ref',
            cardType: 'feature',
            fields: fullFields(),
            completionAction: 'merge',
            specify: false,
          },
        }),
        201,
      )
    ).card;
  const shared = await mk(w.projectId, w.owner.cookie);
  const mine = await mk(own.project.id, b.cookie);
  expect(shared.ref).toBe(mine.ref);
  sharedCardId = shared.id;
  ownCardId = mine.id;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('card refs are ambiguous across organizations (review M7)', () => {
  it("a ref that matches two of the user's projects is a 409 with candidates, never a silent pick", async () => {
    const r = await w.t.req('GET', '/api/cards/TOY-1', { cookie: b.cookie });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ambiguous_ref');
    expect(r.body.error.details.candidates.map((c: any) => c.id).sort()).toEqual(
      [ownCardId, sharedCardId].sort(),
    );
    // an action by ref is refused as well
    const act = await w.t.req('POST', '/api/cards/TOY-1/comments', {
      cookie: b.cookie,
      body: { body: 'hi' },
    });
    expect(act.status).toBe(409);
  });

  it('the card id always resolves, and an unambiguous ref still works for the other user', async () => {
    expect((await ok<any>(w.t.req('GET', `/api/cards/${ownCardId}`, { cookie: b.cookie }))).card.id).toBe(
      ownCardId,
    );
    expect((await ok<any>(w.t.req('GET', `/api/cards/${sharedCardId}`, { cookie: b.cookie }))).card.id).toBe(
      sharedCardId,
    );
    expect((await ok<any>(w.t.req('GET', '/api/cards/TOY-1', { cookie: w.owner.cookie }))).card.id).toBe(
      sharedCardId,
    );
  });
});
