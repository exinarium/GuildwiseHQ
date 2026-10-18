import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../src/commands/common.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// Owner report: "no way to dismiss HR recommendations, and they don't get added". Approving a standing-order proposal
// writes the ledger entry in the same transaction (closeItem), a near-duplicate is a clear 409 (item stays open, merge
// or dismiss), a decline adds nothing, and none of it wakes the CEO.

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
const orgId = async () =>
  (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;

async function propose(title: string, body: string, projectId?: string): Promise<string> {
  const id = randomUUID();
  const org = await orgId();
  await w.t.app.ctx.store.append([
    {
      streamId: `desk-${id}`,
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId: id,
          ...(projectId ? { projectId } : {}),
          kind: 'approval',
          subkind: 'standing_order',
          title: `Add a standing order: ${title}`,
          body,
          blocking: false,
          pinned: false,
          options: [],
          affectedCardIds: [],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectId ? projectScope(org, projectId) : orgScope(org),
    },
  ]);
  return id;
}
const ledger = async (query = '') =>
  (await call('GET', `/api/ledger?scope=standing_order${query}`)).entries as any[];
const item = async (id: string) => (await q('SELECT * FROM desk_items WHERE id=$1', [id]))[0]!;

describe('approving a standing-order proposal', () => {
  it('org-level: the entry is in the ledger at org scope, visible in the org and the project view', async () => {
    const id = await propose('Cite sources', 'Always cite the source of every claim in a report.');
    await call('POST', `/api/desk/${id}/resolve`, { resolution: 'approved' });
    expect(await item(id)).toMatchObject({ status: 'answered' });
    const mine = (await ledger()).filter((e) => e.sourceDeskItemId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ projectId: null, scope: 'standing_order', tags: ['hr'] });
    expect((await ledger(`&projectId=${w.projectId}`)).some((e) => e.sourceDeskItemId === id)).toBe(true);
  });

  it('project-level: the entry keeps the project scope and the edited wording wins', async () => {
    const id = await propose('Small commits', 'Keep every commit under one hundred lines.', w.projectId);
    await call('POST', `/api/desk/${id}/resolve`, {
      resolution: 'approved',
      editedBody: 'Keep each commit small and focused.',
    });
    const mine = (await ledger(`&projectId=${w.projectId}`)).filter((e) => e.sourceDeskItemId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ projectId: w.projectId, body: 'Keep each commit small and focused.' });
    // not an organization-wide order
    expect(
      (await q('SELECT 1 FROM ledger_entries WHERE source_desk_item_id=$1 AND project_id IS NULL', [id]))[0],
    ).toBeUndefined();
  });

  it('a near-duplicate is refused with a clear 409 and the item stays open; merge folds it in; nothing is dropped silently', async () => {
    const first = await propose('Write tests first', 'Write a failing test before changing any behaviour.');
    await call('POST', `/api/desk/${first}/resolve`, { resolution: 'approved' });
    const dupe = await propose('Write tests first', 'Write a failing test before you change any behaviour.');
    const res = await w.t.req('POST', `/api/desk/${dupe}/resolve`, {
      cookie: w.owner.cookie,
      body: { resolution: 'approved' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'duplicate_order' });
    expect(JSON.stringify(res.body)).toContain('already exists');
    expect(await item(dupe)).toMatchObject({ status: 'open' });
    const before = (await ledger()).length;
    await call('POST', `/api/desk/${dupe}/resolve`, { resolution: 'approved', onDuplicate: 'merge' });
    expect(await item(dupe)).toMatchObject({ status: 'answered' });
    expect((await ledger()).length).toBe(before);
    const merged = (await ledger()).find((e) => e.sourceDeskItemId === first);
    expect(merged?.body).toContain('before you change any behaviour');
  });
});

describe('declining a standing-order proposal', () => {
  it('dismiss closes it, adds nothing, and does not wake the CEO', async () => {
    const wakes = async () => Number((await q('SELECT count(*)::int AS n FROM ceo_wakes'))[0]!.n);
    const before = await wakes();
    const entries = (await ledger()).length;
    const id = await propose('Never rebase', 'Never rebase a branch that someone else has pushed to.');
    await call('POST', `/api/desk/${id}/dismiss`, {});
    expect(await item(id)).toMatchObject({ status: 'dismissed' });
    expect((await ledger()).length).toBe(entries);
    expect(await wakes()).toBe(before);
  });

  it('reject (resolution rejected) closes it and adds nothing', async () => {
    const entries = (await ledger()).length;
    const id = await propose('Prefer tabs', 'Indent with tabs in every file of the repository.');
    await call('POST', `/api/desk/${id}/resolve`, { resolution: 'rejected' });
    expect((await item(id)).status).not.toBe('open');
    expect((await ledger()).length).toBe(entries);
  });
});
