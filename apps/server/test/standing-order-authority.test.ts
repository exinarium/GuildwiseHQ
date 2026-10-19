import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizedOrders, ordersBriefSection, orderVersionHash } from '../src/ceo/orders.ts';
import { ceoOwnerChangeEvents } from '../src/ceo/provision.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Standing orders with full power (docs/design/ceo-front-door.md section 3.4 and section 14.4): the Owner marks his own
 * order, the mark is pinned to the wording by hash, any other edit voids it, an Admin's order needs an escalation.
 */
let w: World;
let orgId: string;
let admin: { id: string; cookie: string };

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const as = (cookie: string, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie, body, headers: { 'x-aom-org': orgId } });

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  await appoint(w);
  orgId = (await q(`SELECT id FROM organizations WHERE owner_user_id=$1 LIMIT 1`, [w.owner.id]))[0]!.id;
  admin = await w.t.userSession(uniqueEmail('admin'));
  await w.t.addOrgMember(orgId, admin.id, 'admin');
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

let n = 0;
async function newOrder(
  by: { cookie: string },
  title = `Order ${++n}`,
  body = `Do the thing ${n} when asked.`,
) {
  const r = await ok<any>(
    as(by.cookie, 'POST', '/api/ledger', { scope: 'standing_order', title, body }),
    201,
  );
  return r.entry as { id: string; title: string; body: string; fullPower: any };
}
const entry = async (id: string, cookie = w.owner.cookie) =>
  (await ok<any>(as(cookie, 'GET', `/api/ledger/${id}/history`))).entry as any;
const authorize = (id: string, hash: string, extra: Record<string, unknown> = {}, cookie = w.owner.cookie) =>
  as(cookie, 'POST', `/api/ledger/${id}/authorize`, { versionHash: hash, ...extra });

describe('the Owner marks his own order', () => {
  it('is eligible, pinned to the wording by hash, Owner only, and listed for the CEO', async () => {
    const o = await newOrder(
      w.owner,
      'Triage flagged bugs',
      'When a flagged bug arrives, specify it for the project.',
    );
    expect(o.fullPower).toMatchObject({ state: 'none', eligible: true, current: false });
    expect(o.fullPower.versionHash).toBe(orderVersionHash(o.title, o.body));
    // an Admin may not mark it, nor a wrong or stale hash, nor an unknown key
    expect((await authorize(o.id, o.fullPower.versionHash, {}, admin.cookie)).status).toBe(403);
    expect((await authorize(o.id, 'a'.repeat(64))).status).toBe(409);
    expect((await authorize(o.id, o.fullPower.versionHash, { covers: ['nuke_everything'] })).status).toBe(
      400,
    );
    const res = await ok<any>(
      authorize(o.id, o.fullPower.versionHash, {
        scope: { projectIds: [w.projectId], triggers: ['bug_flagged'] },
        covers: ['devops_destructive'],
      }),
    );
    expect(res.entry.fullPower).toMatchObject({
      state: 'authorized',
      current: true,
      covers: ['devops_destructive'],
      scope: { projectIds: [w.projectId], triggers: ['bug_flagged'] },
    });
    const ev = (
      await q(`SELECT payload FROM events WHERE type='StandingOrderAuthorized' AND payload->>'entryId'=$1`, [
        o.id,
      ])
    )[0]!;
    expect(ev.payload).toMatchObject({ by: w.owner.id, versionHash: orderVersionHash(o.title, o.body) });
    const inForce = await authorizedOrders(w.t.app.ctx.pool, orgId);
    expect(inForce.map((x) => x.entryId)).toContain(o.id);
    expect(await ordersBriefSection(w.t.app.ctx.pool, orgId)).toContain('Triage flagged bugs');
    // revoke in one click, and mark again afterwards
    expect((await as(admin.cookie, 'POST', `/api/ledger/${o.id}/revoke`)).status).toBe(403);
    expect((await ok<any>(owner('POST', `/api/ledger/${o.id}/revoke`))).entry.fullPower.state).toBe(
      'revoked',
    );
    expect((await authorizedOrders(w.t.app.ctx.pool, orgId)).map((x) => x.entryId)).not.toContain(o.id);
    expect((await owner('POST', `/api/ledger/${o.id}/revoke`)).status).toBe(409);
    const again = await ok<any>(authorize(o.id, o.fullPower.versionHash));
    expect(again.entry.fullPower.state).toBe('authorized');
  });

  it('any edit voids the authority; only the Owner with "keep full power" marks the new wording', async () => {
    const o = await newOrder(w.owner);
    await ok(authorize(o.id, o.fullPower.versionHash));
    // an Admin edits: voided, in the same append as the edit
    await ok(as(admin.cookie, 'PATCH', `/api/ledger/${o.id}`, { body: 'Do the thing, but sneakily.' }));
    let e = await entry(o.id);
    expect(e.fullPower).toMatchObject({ state: 'voided', current: false, voidReason: 'edited' });
    expect(
      await q(`SELECT 1 FROM events WHERE type='StandingOrderAuthorityVoided' AND payload->>'entryId'=$1`, [
        o.id,
      ]),
    ).toHaveLength(1);
    expect((await authorizedOrders(w.t.app.ctx.pool, orgId)).map((x) => x.entryId)).not.toContain(o.id);
    // the Owner marks the new wording again
    await ok(authorize(o.id, e.fullPower.versionHash));
    // the Owner edits and keeps full power: re-pinned to the new hash
    await ok(owner('PATCH', `/api/ledger/${o.id}`, { body: 'Do the thing, politely.', keepFullPower: true }));
    e = await entry(o.id);
    expect(e.fullPower).toMatchObject({ state: 'authorized', current: true });
    expect(e.fullPower.versionHash).toBe(orderVersionHash(e.title, 'Do the thing, politely.'));
    // an Admin cannot keep it
    expect(
      (
        await as(admin.cookie, 'PATCH', `/api/ledger/${o.id}`, {
          body: 'Changed again.',
          keepFullPower: true,
        })
      ).status,
    ).toBe(403);
    // the Owner edits without ticking: voided
    await ok(owner('PATCH', `/api/ledger/${o.id}`, { body: 'One more change.' }));
    expect((await entry(o.id)).fullPower.state).toBe('voided');
  });

  it('retiring the order voids it, and a retired order cannot be marked', async () => {
    const o = await newOrder(w.owner);
    await ok(authorize(o.id, o.fullPower.versionHash));
    await ok(owner('POST', `/api/ledger/${o.id}/retire`, { reason: 'not needed any more' }));
    const e = (await ok<any>(owner('GET', '/api/ledger?includeRetired=true'))).entries.find(
      (x: any) => x.id === o.id,
    );
    expect(e.fullPower.state).toBe('voided');
    expect((await authorizedOrders(w.t.app.ctx.pool, orgId)).map((x) => x.entryId)).not.toContain(o.id);
    expect((await authorize(o.id, e.fullPower.versionHash)).status).toBe(409);
  });
});

describe('who may carry full power (docs section 14.4 and 0.2)', () => {
  it("an Admin's order is not eligible until he escalates it and the Owner marks it as his own", async () => {
    const o = await newOrder(admin);
    const seen = await entry(o.id);
    expect(seen.fullPower).toMatchObject({ eligible: false, escalated: false });
    expect(seen.fullPower.ineligibleReason).toContain('Admin');
    expect((await authorize(o.id, seen.fullPower.versionHash)).status).toBe(409);
    // a member cannot escalate; the Admin can, and the Owner gets a desk notice addressed to him
    const member = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(orgId, member.id, 'member');
    expect((await as(member.cookie, 'POST', `/api/ledger/${o.id}/escalate`, { note: '' })).status).toBe(403);
    await ok(as(admin.cookie, 'POST', `/api/ledger/${o.id}/escalate`, { note: 'Please take this one.' }));
    const notice = (
      await q(`SELECT * FROM desk_items WHERE subkind='order_escalation' AND data->>'entryId'=$1`, [o.id])
    )[0]!;
    expect(notice).toMatchObject({ kind: 'alert', status: 'open', addressee_user_id: w.owner.id });
    expect(notice.body).toContain('Please take this one.');
    const after = await entry(o.id);
    expect(after.fullPower).toMatchObject({ eligible: true, escalated: true, state: 'none' });
    await ok(authorize(o.id, after.fullPower.versionHash));
    expect((await entry(o.id)).fullPower.state).toBe('authorized');
  });

  it('an order the CEO created is not eligible (authorship is the actor, never the Owner by proxy)', async () => {
    const ceoId = (await q(`SELECT id FROM agents WHERE role_key='ceo' AND status <> 'retired'`))[0]!.id;
    const entryId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.ledger(entryId),
        event: {
          type: 'LedgerEntryAdded',
          payload: {
            entryId,
            scope: 'standing_order',
            title: 'Activated by the CEO',
            body: 'Do something big.',
            tags: [],
          },
        },
        actor: { kind: 'agent', id: ceoId },
        scope: { orgId: w.owner.id, projectId: null, audience: 'org' },
      },
    ]);
    const e = await entry(entryId);
    expect(e.fullPower).toMatchObject({ eligible: false });
    expect(e.fullPower.ineligibleReason).toContain('agent');
    expect((await authorize(entryId, e.fullPower.versionHash)).status).toBe(409);
  });

  it('a change of Owner voids every mark: the new Owner marks them again', async () => {
    const o = await newOrder(w.owner);
    await ok(authorize(o.id, o.fullPower.versionHash));
    const events = await ceoOwnerChangeEvents(w.t.app.ctx.pool, orgId, admin.id);
    await w.t.app.ctx.store.append(events);
    expect((await entry(o.id)).fullPower).toMatchObject({ state: 'voided', voidReason: 'owner_changed' });
  });

  it('survives a projection rebuild', async () => {
    const o = await newOrder(w.owner);
    await ok(authorize(o.id, o.fullPower.versionHash, { covers: ['manual_qa'] }));
    const v = await newOrder(w.owner);
    await ok(authorize(v.id, v.fullPower.versionHash));
    await ok(owner('PATCH', `/api/ledger/${v.id}`, { body: 'Changed so it is voided.' }));
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    await q(`UPDATE agents SET runtime='mock', model='mock' WHERE role_key='ceo'`);
    expect((await entry(o.id)).fullPower).toMatchObject({ state: 'authorized', covers: ['manual_qa'] });
    expect((await entry(v.id)).fullPower.state).toBe('voided');
  });
});
