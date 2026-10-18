import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('card priority labels (Urgent 1, High 3, Normal 5, Low 8)', () => {
  it('a card nobody prioritised is Normal (5); an explicit priority is kept', async () => {
    const plain = await w.card({ title: 'plain' });
    const urgent = await w.card({ title: 'urgent', priority: 1 });
    expect(plain.priority).toBe(5);
    expect(urgent.priority).toBe(1);
    const got = await ok<any>(w.t.req('GET', `/api/cards/${plain.id}`, { cookie: w.owner.cookie }));
    expect(got.card.priority).toBe(5);
  });

  it('the old default (2) reads as Normal when a card is projected, also after a rebuild', async () => {
    const model = {
      ...(await q(`SELECT payload FROM events WHERE type='CardCreated' ORDER BY seq LIMIT 1`))[0]?.payload,
    };
    // an event from before priorities had labels carries no scale marker
    delete model.priorityScale;
    const cardId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.card(cardId),
        event: {
          type: 'CardCreated',
          payload: { ...model, cardId, number: 900, ref: 'TOY-900', title: 'legacy', priority: 2 },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const },
      },
    ]);
    expect((await q('SELECT priority FROM cards WHERE id=$1', [cardId]))[0]?.priority).toBe(5);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await q('SELECT priority FROM cards WHERE id=$1', [cardId]))[0]?.priority).toBe(5);
  });

  it('a conscious 2 is stored as 2 (also after a rebuild); only an old event without the scale marker reads 2 as 5', async () => {
    const two = await w.card({ title: 'two', priority: 2 });
    expect(two.priority).toBe(2);
    const ev = (
      await q(`SELECT payload FROM events WHERE type='CardCreated' AND payload->>'cardId'=$1`, [two.id])
    )[0]?.payload;
    expect(ev.priorityScale).toBe(2);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await q('SELECT priority FROM cards WHERE id=$1', [two.id]))[0]?.priority).toBe(2);
  });
});
