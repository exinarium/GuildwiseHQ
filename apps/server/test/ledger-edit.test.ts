import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { standingOrdersFor } from '../src/queries/ledger.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// Backlog #74: a standing order can be edited in place; the earlier wording stays in its history.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), status);
const add = (body: Record<string, unknown>) =>
  call('POST', '/api/ledger', { scope: 'standing_order', ...body }, 201).then((r) => r.entry);

describe('editing a standing order', () => {
  it('changes the wording in place, keeps the earlier wordings, and the next brief carries the new one', async () => {
    const e = await add({
      title: 'Branches',
      body: 'Ask which branch to use, zebra.',
      projectId: w.projectId,
    });
    expect(e).toMatchObject({ version: 1, editedAt: null, canEdit: true });

    const edited = await call('PATCH', `/api/ledger/${e.id}`, { body: 'Never ask which branch to use.' });
    expect(edited.entry).toMatchObject({
      id: e.id,
      title: 'Branches',
      body: 'Never ask which branch to use.',
      version: 2,
      editedByName: expect.any(String),
    });
    await call('PATCH', `/api/ledger/${e.id}`, { title: 'Working branch', tags: ['git'] });

    const history = await call('GET', `/api/ledger/${e.id}/history`);
    expect(history.versions.map((v: any) => [v.version, v.title, v.body, v.current])).toEqual([
      [3, 'Working branch', 'Never ask which branch to use.', true],
      [2, 'Branches', 'Never ask which branch to use.', false],
      [1, 'Branches', 'Ask which branch to use, zebra.', false],
    ]);
    expect(history.versions[0].tags).toEqual(['git']);

    // what the briefs are built from
    const orgId = (await q('SELECT org_id FROM ledger_entries WHERE id=$1', [e.id]))[0]?.org_id as string;
    const orders = await standingOrdersFor(w.t.app.ctx.pool, orgId, w.projectId);
    expect(orders.filter((o) => o.title.startsWith('Working'))).toEqual([
      { title: 'Working branch', body: 'Never ask which branch to use.' },
    ]);
    expect(orders.some((o) => o.body === 'Ask which branch to use, zebra.')).toBe(false);
    // the list shows one live row, with the search index on the new text
    const found = await call('GET', '/api/ledger?q=never+ask+branch&scope=standing_order');
    expect(found.entries.map((x: any) => x.id)).toContain(e.id);
    expect((await call('GET', '/api/ledger?q=zebra&scope=standing_order')).entries).toEqual([]);
  });

  it('an unchanged edit makes no new version; an empty edit is refused', async () => {
    const e = await add({ title: 'Same', body: 'Stay the same.' });
    await call('PATCH', `/api/ledger/${e.id}`, { body: 'Stay the same.' });
    expect((await call('GET', `/api/ledger/${e.id}/history`)).versions).toHaveLength(1);
    await call('PATCH', `/api/ledger/${e.id}`, {}, 400);
  });

  it('only live standing orders can be edited', async () => {
    const dec = await call(
      'POST',
      '/api/ledger',
      { scope: 'decision', projectId: w.projectId, title: 'Use pnpm', body: 'We use pnpm.' },
      201,
    );
    await call('PATCH', `/api/ledger/${dec.entry.id}`, { body: 'We use npm.' }, 409);
    const old = await add({ title: 'Old', body: 'Old rule.' });
    const newer = await add({ title: 'New', body: 'New rule.' });
    await q('UPDATE ledger_entries SET superseded_by=$2 WHERE id=$1', [old.id, newer.id]);
    await call('PATCH', `/api/ledger/${old.id}`, { body: 'Edited old.' }, 409);
    await call('PATCH', '/api/ledger/00000000-0000-4000-8000-000000000000', { body: 'x' }, 404);
  });

  it('is event sourced: one LedgerEntryEdited per change', async () => {
    const e = await add({ title: 'Events', body: 'Before.' });
    await call('PATCH', `/api/ledger/${e.id}`, { body: 'After.' });
    const types = await q(`SELECT type FROM events WHERE payload->>'entryId' = $1 ORDER BY seq`, [e.id]);
    expect(types.map((x: any) => x.type)).toEqual(['LedgerEntryAdded', 'LedgerEntryEdited']);
  });
});
