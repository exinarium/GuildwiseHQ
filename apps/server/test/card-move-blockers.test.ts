import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// A manual move clears the card's stale blockers (by events), says so when dependencies have not landed, and the
// card query lists the stages a move accepts.
let w: World;
beforeAll(async () => {
  w = await createWorld({ listen: false });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

/** A blocking desk item holding `cardId` (and `alsoCardIds`). */
async function block(cardId: string, subkind: string, alsoCardIds: string[] = []) {
  const id = randomUUID();
  await seed(w, [
    {
      streamId: streamId.desk(id),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId: id,
          kind: 'escalation',
          subkind,
          title: `${subkind} item`,
          body: 'b',
          options: [],
          blocking: true,
          pinned: true,
          cardId,
          projectId: w.projectId,
          affectedCardIds: [cardId, ...alsoCardIds],
          askedBy: { kind: 'system' },
        },
      },
      actor: { kind: 'system', id: null },
      scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
    },
  ]);
  return id;
}
const move = (cardId: string, toStage: string, reason = 'unstick') =>
  w.t.req('POST', `/api/cards/${cardId}/move`, { cookie: w.owner.cookie, body: { toStage, reason } });
const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const itemRow = async (id: string) => (await q('SELECT * FROM desk_items WHERE id=$1', [id]))[0]!;

describe('a manual move and the open blockers of the card', () => {
  it('dismisses every open blocker with a note, clears blocked_since and the back-off', async () => {
    const card = await w.card({ title: 'Stale blockers' });
    const other = await w.card({ title: 'Other card' });
    const a = await block(card.id, 'repeat_loop');
    const b = await block(card.id, 'stop_loss');
    const shared = await block(card.id, 'custom_hold', [other.id]);
    await q(`UPDATE cards SET retry_after = now() + interval '1 hour', retry_failures = 3 WHERE id=$1`, [
      card.id,
    ]);
    expect(await cardRow(card.id)).toMatchObject({ status: 'blocked' });
    expect((await cardRow(card.id)).blocked_since).toBeTruthy();

    const res = await move(card.id, 'spec');
    expect(res.status).toBe(200);
    const c = await cardRow(card.id);
    expect(c).toMatchObject({ stage: 'spec', status: 'draft', blocked_since: null, retry_after: null });
    for (const id of [a, b]) {
      const item = await itemRow(id);
      expect(item.status).toBe('dismissed');
      expect(item.answer).toMatch(/^moved by /);
    }
    // An item that holds another card too stays open for it; this card no longer waits on it.
    expect((await itemRow(shared)).status).toBe('open');
    expect(await q('SELECT 1 FROM card_blockers WHERE card_id=$1', [card.id])).toHaveLength(0);
    const resolved = await q(
      `SELECT 1 FROM events WHERE type='DeskItemResolved' AND payload->>'deskItemId' = ANY($1)`,
      [[a, b]],
    );
    expect(resolved).toHaveLength(2);
  });

  it('accepts a move into a stage whose dependencies have not landed and returns a notice', async () => {
    const dep = await w.card({ title: 'Dependency' });
    const card = await w.card({ title: 'Waiting card', dependencies: [dep.id] });
    const res = await move(card.id, 'spec');
    expect(res.status).toBe(200);
    expect(res.body.moveNotice).toBeUndefined();
    const built = await move(card.id, 'build');
    expect(built.status).toBe(200);
    expect(built.body.card).toMatchObject({ stage: 'build' });
    expect(built.body.moveNotice).toMatch(new RegExp(`nothing will run in .* until ${dep.ref}`));
  });
});

describe('the stages the card query offers for a move', () => {
  it('lists only stages moveCard accepts, without the current one', async () => {
    const card = await w.card({ title: 'Picker' });
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    const ids = detail.moveTargets.map((s: any) => s.id);
    expect(ids).not.toContain(card.stage);
    expect(ids).toContain('spec');
    expect(detail.moveTargets.every((s: any) => ['agent', 'manual'].includes(s.kind))).toBe(true);
    // Every offered stage is accepted by the server.
    for (const id of ids) {
      const res = await move(card.id, id);
      expect(res.status, `moving to ${id}`).toBe(200);
    }
  });

  it('offers nothing for a card that is closed', async () => {
    const card = await w.card({ title: 'Closed' });
    await ok(
      w.t.req('POST', `/api/cards/${card.id}/cancel`, { cookie: w.owner.cookie, body: { reason: 'x' } }),
    );
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(detail.moveTargets).toEqual([]);
  });
});
