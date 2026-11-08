import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devopsCardBrief } from '../src/runner-gateway/brief.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, fullFields, type World } from './helpers/world.ts';

/** A card made from a client ticket is known outside by the ticket: drafts that name its internal key are refused. */

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

const owner = {
  get: (url: string) => w.t.req('GET', url, { cookie: w.owner.cookie }),
  post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie: w.owner.cookie, body }),
};
const ticketCard = (key: string) => w.card({ fields: fullFields({ externalRef: key }) });
const draft = (cardId: string, body: string) =>
  owner.post(`/api/cards/${cardId}/outbound`, { kind: 'comment', body });
const outboundItem = async (cardId: string) =>
  ((await owner.get('/api/desk')).body.items as any[]).find(
    (i) => i.subkind === 'outbound' && i.card?.id === cardId && i.status === 'open',
  );

describe('outbound drafts for an intake card', () => {
  it('a draft that names the internal card key is refused; one that names the ticket lands', async () => {
    const card = await ticketCard('WREF-1');
    const bad = await draft(card.id, `Fixed in ${card.ref}: the export now includes archived items.`);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('internal_details');
    expect(bad.body.error.details.matches.join(' ')).toContain(
      `"${card.ref}" (internal card key (name the ticket WREF-1 instead))`,
    );
    expect(await q('SELECT 1 FROM outbound_drafts WHERE card_id=$1', [card.id])).toHaveLength(0);

    const good = await draft(card.id, 'Fixed for WREF-1: the export now includes archived items.');
    expect(good.status).toBe(201);
    expect(good.body.draft).toMatchObject({ externalKey: 'WREF-1', status: 'pending' });
    expect(good.body.draft.body).not.toContain(card.ref);
    // Internal surfaces keep the internal ref.
    const item = await outboundItem(card.id);
    expect(item.card.ref).toBe(card.ref);
  });

  it("the manager's edit that names the internal key is refused before approval", async () => {
    const card = await ticketCard('WREF-2');
    await draft(card.id, 'The fix is in.');
    const item = await outboundItem(card.id);
    const edit = await owner.post(`/api/desk/${item.id}/resolve`, {
      resolution: 'approved',
      editedBody: `Done, see ${card.ref}.`,
    });
    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe('internal_details');
    expect((await q('SELECT status FROM outbound_drafts WHERE card_id=$1', [card.id]))[0]?.status).toBe(
      'pending',
    );
  });
});

describe('the DevOps card brief', () => {
  it('carries the work reference of an intake card and the internal ref otherwise', async () => {
    const intake = await ticketCard('WREF-3');
    const plain = await w.card({ fields: fullFields({}) });
    const orgId = (await q('SELECT org_id FROM cards WHERE id=$1', [intake.id]))[0]?.org_id;
    expect(await devopsCardBrief(w.t.app.ctx, intake.id, orgId)).toMatchObject({
      ref: intake.ref,
      workRef: 'WREF-3',
      isClientRef: true,
    });
    expect(await devopsCardBrief(w.t.app.ctx, plain.id, orgId)).toMatchObject({
      ref: plain.ref,
      workRef: plain.ref,
      isClientRef: false,
    });
  });
});
