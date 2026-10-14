import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, appoint, ceo, graduate, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let shiftId: string;
let signalId: string;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await w.hire('Bea', 'builder', 'junior', { model: 'sonnet' });
  await w.hire('Sam', 'builder', 'senior', { model: 'sonnet' });
  await appoint(w);
  await graduate(w);
  await wakeNow(w);
  shiftId = (await startCeoShift(w, r)).shiftId;
  signalId = randomUUID();
  await q(
    `INSERT INTO ba_signals (id, org_id, project_id, kind, fingerprint, urgency, subject, count, status, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,'unclaimed','fp-2','normal','{"title":"Queue is long"}',3,'open',now(),now())`,
    [signalId, w.owner.id, w.projectId],
  );
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const result = (resp: any) => {
  expect(resp.ok, JSON.stringify(resp)).toBe(true);
  return resp.result;
};
const agent = async (name: string) => (await q(`SELECT * FROM agents WHERE name=$1`, [name]))[0]!;
const setMode = async (cls: string, mode: string) => {
  const pol = (await ok<any>(owner('GET', '/api/ceo/policy'))).policy;
  pol.classes[cls].mode = mode;
  await ok(owner('PUT', '/api/ceo/policy', { policy: pol }));
};

describe('cards', () => {
  it('reassigns a queued card to an agent and posts a note', async () => {
    const card = await w.card({ title: 'Move me' });
    const res = result(await act(r, shiftId, 'reassign', { card: card.ref, agent: 'Sam' }));
    expect(res.status).toBe('executed');
    expect(
      await q(`SELECT 1 FROM events WHERE type='CardReassigned' AND payload->>'cardId'=$1`, [card.id]),
    ).toHaveLength(1);
    const same = result(await act(r, shiftId, 'reassign', { card: card.ref, agent: 'Nobody' }));
    expect(same.status).toBe('refused');
    expect(w.t.app.ctx.services.dispatcher.preferred.get(card.id)?.agentId).toBe((await agent('Sam')).id);
  });

  it('cancelling a card is a recommendation by default; when delegated it runs and can be undone', async () => {
    const card = await w.card({ title: 'Obsolete' });
    const rec = result(await act(r, shiftId, 'cancel-card', { card: card.ref, note: 'obsolete' }));
    expect(rec.status).toBe('recommended');
    expect((await q(`SELECT status FROM cards WHERE id=$1`, [card.id]))[0]!.status).toBe('queued');
    await setMode('card.cancel', 'decide');
    const done = result(
      await act(r, shiftId, 'cancel-card', { card: card.ref, note: 'obsolete' }, { key: 'cancel-2' }),
    );
    expect(done.status).toBe('executed');
    expect((await q(`SELECT status FROM cards WHERE id=$1`, [card.id]))[0]!.status).toBe('cancelled');
    await ok(owner('POST', `/api/ceo/actions/${done.actionId}/undo`));
    expect((await q(`SELECT status FROM cards WHERE id=$1`, [card.id]))[0]!.status).not.toBe('cancelled');
    await setMode('card.cancel', 'recommend');
  });

  it('asks the BA for a card: it is drafted and specified, and can be cancelled by undo', async () => {
    await w.hire('Ben', 'ba', 'senior');
    const res = result(
      await act(r, shiftId, 'intake', {
        project: 'TOY',
        text: 'Customers want an export to CSV of their cards.\nInclude the filters.',
      }),
    );
    expect(res.status, JSON.stringify(res)).toBe('executed');
    const card = (await q(`SELECT * FROM cards WHERE id=$1`, [res.result.cardId]))[0]!;
    expect(card.title).toContain('export to CSV');
    expect(card.fields.context).toContain('Include the filters');
    await ok(owner('POST', `/api/ceo/actions/${res.actionId}/undo`));
    expect((await q(`SELECT status FROM cards WHERE id=$1`, [card.id]))[0]!.status).toBe('cancelled');
  });
});

describe('agents', () => {
  it('moves a model one tier at a time, once a week, and undoes it', async () => {
    const jump = result(await act(r, shiftId, 'model', { agent: 'Bea', to: 'gpt-9' }));
    expect(jump.status).toBe('refused'); // not on the ladder
    const up = result(await act(r, shiftId, 'model', { agent: 'Bea', to: 'opus' }));
    expect(up.status).toBe('executed');
    expect((await agent('Bea')).model).toBe('opus');
    const again = result(await act(r, shiftId, 'model', { agent: 'Bea', to: 'sonnet' }));
    expect(again.status).toBe('recommended');
    expect(again.message).toContain('one model change per agent per week');
    await ok(owner('POST', `/api/ceo/actions/${up.actionId}/undo`));
    expect((await agent('Bea')).model).toBe('sonnet');
  });

  it('a model-up is held back when it would pass the budget forecast', async () => {
    await ok(owner('PUT', `/api/projects/${w.projectId}/budget`, { monthly: 1 }));
    await q(
      `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, kind, model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd_micros, ended_at, cost_stamped)
       VALUES (gen_random_uuid(), $1, $2, $3, 'card', 'mock', 1,1,0,0, 950000, now(), true)`,
      [w.owner.id, (await agent('Sam')).id, w.projectId],
    );
    const res = result(await act(r, shiftId, 'model', { agent: 'Sam', to: 'opus' }));
    expect(res.status).toBe('recommended');
    expect(res.message).toContain('budget');
    await ok(owner('PUT', `/api/projects/${w.projectId}/budget`, { monthly: null }));
  });

  it('promotes and demotes, and undoes', async () => {
    const res = result(await act(r, shiftId, 'seniority', { agent: 'Bea', to: 'senior' }));
    expect(res.status).toBe('executed');
    expect((await agent('Bea')).seniority).toBe('senior');
    await ok(owner('POST', `/api/ceo/actions/${res.actionId}/undo`));
    expect((await agent('Bea')).seniority).toBe('junior');
  });

  it('benches an agent and restores it by undo', async () => {
    await w.hire('Tom', 'reviewer', 'senior');
    const b = result(await act(r, shiftId, 'bench', { agent: 'Tom' }));
    expect(b.status).toBe('executed');
    expect((await agent('Tom')).allowed_project_ids).toEqual([]);
    await ok(owner('POST', `/api/ceo/actions/${b.actionId}/undo`));
    expect((await agent('Tom')).allowed_project_ids).toBeNull();
    // the owner undid it: the same bench is not repeated, it becomes a recommendation
    const again = result(await act(r, shiftId, 'bench', { agent: 'Tom' }, { key: 'bench-tom-2' }));
    expect(again.status).toBe('recommended');
    expect(again.message).toContain('undid');
  });

  it("retiring needs a bench first and the owner's confirmation", async () => {
    const early = result(await act(r, shiftId, 'retire', { agent: 'Sam' }));
    expect(early.status).toBe('refused');
    expect(early.message).toContain('bench');
    result(await act(r, shiftId, 'bench', { agent: 'Sam' }));
    const rec = result(await act(r, shiftId, 'retire', { agent: 'Sam' }, { key: 'retire-sam' }));
    expect(rec.status).toBe('recommended'); // irreversible: always the owner
    expect((await agent('Sam')).status).toBe('active');
    const row = (await q(`SELECT desk_item_id FROM ceo_actions WHERE id=$1`, [rec.actionId]))[0]!;
    await ok(owner('POST', `/api/desk/${row.desk_item_id}/resolve`, { resolution: 'approved' }));
    expect((await agent('Sam')).status).toBe('retired');
  });

  it('scales a role up and down with the same guard rails', async () => {
    const up = result(
      await act(
        r,
        shiftId,
        'scale',
        { role: 'builder', project: 'TOY', to: 2, seniority: 'junior' },
        { evidence: [`signal:${signalId}`] },
      ),
    );
    expect(up.status, JSON.stringify(up)).toBe('executed');
    expect(up.result.agentIds).toHaveLength(1);
    expect(await q(`SELECT 1 FROM agents WHERE role_key='builder' AND status='active'`)).toHaveLength(2);
    const noop = result(
      await act(
        r,
        shiftId,
        'scale',
        { role: 'builder', project: 'TOY', to: 2 },
        { evidence: [`signal:${signalId}`], key: 'n2' },
      ),
    );
    expect(noop.status).toBe('refused');
    const down = result(
      await act(r, shiftId, 'scale', { role: 'builder', project: 'TOY', to: 1 }, { key: 'down' }),
    );
    expect(down.status).toBe('executed');
    await ok(owner('POST', `/api/ceo/actions/${down.actionId}/undo`));
    await ok(owner('POST', `/api/ceo/actions/${up.actionId}/undo`));
  });
});

describe('standing orders', () => {
  it('proposing is a desk approval that becomes a ledger standing order; activating directly is a recommendation', async () => {
    const text = 'Run the linter before every handoff and quote its output.';
    const prop = result(await act(r, shiftId, 'propose-order', { scope: 'org', text }));
    expect(prop.status).toBe('executed');
    const item = (await q(`SELECT id FROM desk_items WHERE subkind='standing_order' AND status='open'`))[0]!;
    await ok(owner('POST', `/api/desk/${item.id}/resolve`, { resolution: 'approved' }));
    await new Promise((x) => setTimeout(x, 150));
    expect(
      (await q(`SELECT body FROM ledger_entries WHERE scope='standing_order'`)).some((l) =>
        l.body.includes('linter'),
      ),
    ).toBe(true);
    const act2 = result(
      await act(r, shiftId, 'activate-order', {
        scope: 'org',
        text: 'Always write the changelog before finalizing.',
      }),
    );
    expect(act2.status).toBe('recommended');
    expect((await q(`SELECT 1 FROM ledger_entries WHERE body LIKE '%changelog%'`)).length).toBe(0);
    const rec = (await q(`SELECT desk_item_id FROM ceo_actions WHERE id=$1`, [act2.actionId]))[0]!;
    await ok(owner('POST', `/api/desk/${rec.desk_item_id}/resolve`, { resolution: 'approved' }));
    expect(
      (await q(`SELECT 1 FROM ledger_entries WHERE body LIKE '%changelog%' AND scope='standing_order'`))
        .length,
    ).toBe(1);
  });
});

describe('agent pause by managers', () => {
  it('a manager can pause and resume an agent from the API; the CEO cannot be paused this way', async () => {
    const sam = await agent('Tom');
    await ok(owner('POST', `/api/agents/${sam.id}/pause`));
    expect((await agent('Tom')).paused_at).not.toBeNull();
    await ok(owner('POST', `/api/agents/${sam.id}/resume`));
    expect((await agent('Tom')).paused_at).toBeNull();
    const ceoId = (await q(`SELECT id FROM agents WHERE role_key='ceo'`))[0]!.id;
    expect((await owner('POST', `/api/agents/${ceoId}/pause`)).status).toBe(400);
  });
});

void ceo;
