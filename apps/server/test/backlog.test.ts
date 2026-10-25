import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postCeoReport } from '../src/ceo/report.ts';
import { addBacklogSuggestionRpc } from '../src/commands/backlog.ts';
import { act, appoint, ceo, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, type World } from './helpers/world.ts';

/** The project backlog (GWP-3): HTTP, Send to BA, agent suggestions, the daily report notice and the CEO's verbs. */
let w: World;
let orgId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  orgId = (
    await q(`SELECT id FROM organizations WHERE owner_user_id=$1 ORDER BY created_at LIMIT 1`, [w.owner.id])
  )[0]?.id as string;
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const cookie = () => w.owner.cookie;
const call = async (method: string, url: string, body?: unknown, status = 200) => {
  const r = await w.t.req(method, url, { cookie: cookie(), ...(body !== undefined ? { body } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const add = (title: string, over: Record<string, unknown> = {}) =>
  call('POST', `/api/projects/${w.projectId}/backlog`, { title, ...over }, 201).then((b) => b.item);
const list = (query = '') =>
  call('GET', `/api/projects/${w.projectId}/backlog${query}`).then((b) => b.items as any[]);
const counts = async () => ({
  cards: (await q('SELECT count(*)::int AS n FROM cards'))[0]!.n,
  desk: (await q('SELECT count(*)::int AS n FROM desk_items'))[0]!.n,
  shifts: (await q('SELECT count(*)::int AS n FROM shifts'))[0]!.n,
  tasks: (await q('SELECT count(*)::int AS n FROM ba_tasks'))[0]!.n,
});

describe('items', () => {
  it('quick add: Open, owner, Normal, no tags, not flagged; a blank title is refused', async () => {
    const item = await add('Dark mode');
    expect(item).toMatchObject({
      title: 'Dark mode',
      status: 'open',
      priority: 'normal',
      tags: [],
      flagged: false,
      source: { kind: 'owner' },
      cardRef: null,
    });
    await call('POST', `/api/projects/${w.projectId}/backlog`, { title: '   ' }, 400);
  });

  it('create, edit, flag and drop create no card, desk item, shift or BA task', async () => {
    const before = await counts();
    const item = await add('No side effects', { tags: ['UI', 'ui'] });
    expect(item.tags).toEqual(['ui']);
    const edited = await call('PATCH', `/api/backlog/${item.id}`, {
      title: 'Edited',
      description: 'What we want',
      priority: 'high',
      tags: ['a', 'b'],
    });
    expect(edited.item).toMatchObject({
      title: 'Edited',
      description: 'What we want',
      priority: 'high',
      tags: ['a', 'b'],
    });
    expect((await call('PATCH', `/api/backlog/${item.id}`, { flagged: true })).item.flagged).toBe(true);
    expect((await call('POST', `/api/backlog/${item.id}/drop`)).item.status).toBe('dropped');
    expect(await counts()).toEqual(before);
  });

  it('source, status and the linked card cannot be edited', async () => {
    const item = await add('Strict');
    for (const bad of [{ status: 'done' }, { source: { kind: 'agent' } }, { cardRef: 'TOY-1' }])
      await call('PATCH', `/api/backlog/${item.id}`, bad, 400);
  });

  it('the default list is Open only; Done and Dropped show with the status filter', async () => {
    const item = await add('To be dropped');
    await call('POST', `/api/backlog/${item.id}/drop`);
    expect((await list()).map((i) => i.id)).not.toContain(item.id);
    expect((await list('?status=dropped')).map((i) => i.id)).toContain(item.id);
    expect((await list('?status=open,dropped')).map((i) => i.id)).toContain(item.id);
  });

  it('filters by flag, priority and tag, searches, and sorts by priority', async () => {
    const lo = await add('Zeta task', { priority: 'low', tags: ['filtertag'] });
    const cr = await add('Alpha task', { priority: 'critical', tags: ['filtertag'], flagged: true });
    const only = await list('?tag=filtertag');
    expect(only.map((i) => i.id)).toEqual([cr.id, lo.id]);
    expect((await list('?tag=filtertag&flagged=true')).map((i) => i.id)).toEqual([cr.id]);
    expect((await list('?tag=filtertag&priority=low')).map((i) => i.id)).toEqual([lo.id]);
    expect((await list('?q=zeta')).map((i) => i.id)).toEqual([lo.id]);
    expect((await list('?tag=filtertag&sort=created')).map((i) => i.id)).toEqual([cr.id, lo.id]);
  });

  it('a member cannot change the backlog but can read it; another project does not see the item', async () => {
    const item = await add('Members read');
    const member = await w.t.userSession('member-backlog@example.com', 'member');
    const r = await w.t.req('POST', `/api/projects/${w.projectId}/backlog`, {
      cookie: member.cookie,
      body: { title: 'x' },
    });
    expect([403, 404]).toContain(r.status);
    const other = await w.t.userSession('stranger-backlog@example.com', 'member');
    expect(
      (await w.t.req('PATCH', `/api/backlog/${item.id}`, { cookie: other.cookie, body: { flagged: true } }))
        .status,
    ).toBe(404);
  });
});

describe('Send to BA', () => {
  it('bulk send of an item the user cannot see names the id, never its title', async () => {
    const item = await add('Secret title of another org');
    const other = await w.t.userSession('stranger-bulk@example.com', 'member');
    const r = await w.t.req('POST', '/api/backlog/send', {
      cookie: other.cookie,
      body: { itemIds: [item.id] },
    });
    expect(JSON.stringify(r.body)).not.toContain('Secret title');
    expect((await list()).find((i) => i.id === item.id)).toMatchObject({ status: 'open', cardRef: null });
  });

  it('without a BA it is refused (409 no_ba) and the item stays Open and unlinked', async () => {
    const item = await add('Needs a BA');
    const before = await counts();
    const r = await w.t.req('POST', `/api/backlog/${item.id}/send`, { cookie: cookie(), body: {} });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('no_ba');
    expect(await counts()).toEqual(before);
    expect((await list()).find((i) => i.id === item.id)).toMatchObject({ status: 'open', cardRef: null });
  });

  it('with a BA: one draft card with the priority and tags, a BA task, the item Done and linked', async () => {
    await w.hire('Ben', 'ba', 'senior');
    const item = await add('Send me', {
      description: 'Please build the thing',
      priority: 'high',
      tags: ['ui', 'onboarding'],
    });
    const before = await counts();
    const out = await call('POST', `/api/backlog/${item.id}/send`);
    expect(out.result.ok).toBe(true);
    expect(out.item).toMatchObject({ status: 'done', cardRef: out.result.cardRef });
    const card = (await q('SELECT * FROM cards WHERE ref=$1', [out.result.cardRef]))[0]!;
    expect(card).toMatchObject({ project_id: w.projectId, priority: 3, title: 'Send me' });
    expect(card.fields.context).toContain('Please build the thing');
    expect(card.fields.context).toContain('Priority: High');
    expect(card.fields.context).toContain('Tags: ui, onboarding');
    expect(await q(`SELECT kind FROM ba_tasks WHERE card_id=$1`, [card.id])).toEqual([{ kind: 'spec_card' }]);
    const after = await counts();
    expect(after.cards).toBe(before.cards + 1);
    expect((await list()).map((i) => i.id)).not.toContain(item.id);
    expect((await list('?status=done')).find((i) => i.id === item.id)).toMatchObject({
      cardRef: out.result.cardRef,
    });
  });

  it('Done and Dropped items cannot be sent again', async () => {
    const done = await add('Sent once');
    await call('POST', `/api/backlog/${done.id}/send`);
    const again = await w.t.req('POST', `/api/backlog/${done.id}/send`, { cookie: cookie(), body: {} });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('backlog_not_open');
    const dropped = await add('Dropped first');
    await call('POST', `/api/backlog/${dropped.id}/drop`);
    const r = await w.t.req('POST', `/api/backlog/${dropped.id}/send`, { cookie: cookie(), body: {} });
    expect(r.status).toBe(409);
  });

  it('an item of an archived project cannot be sent (409 project_archived) and stays Open', async () => {
    const item = await add('Archived project');
    await q(`UPDATE projects SET status='archived' WHERE id=$1`, [w.projectId]);
    try {
      const r = await w.t.req('POST', `/api/backlog/${item.id}/send`, { cookie: cookie(), body: {} });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('project_archived');
    } finally {
      await q(`UPDATE projects SET status='active' WHERE id=$1`, [w.projectId]);
    }
    expect((await list()).find((i) => i.id === item.id)).toMatchObject({ status: 'open', cardRef: null });
  });

  it('bulk: each item becomes its own card; a failed item stays Open and is named', async () => {
    const a = await add('Bulk A');
    const b = await add('Bulk B');
    const c = await add('Bulk C');
    await call('POST', `/api/backlog/${b.id}/drop`);
    const before = await counts();
    const out = await call('POST', '/api/backlog/send', { itemIds: [a.id, b.id, c.id] });
    expect(out.results.map((r: any) => r.ok)).toEqual([true, false, true]);
    expect(out.results[1]).toMatchObject({ itemId: b.id, title: 'Bulk B', code: 'backlog_not_open' });
    expect(out.results[0].cardRef).not.toBe(out.results[2].cardRef);
    expect((await counts()).cards).toBe(before.cards + 2);
    const done = await list('?status=done');
    expect(done.find((i) => i.id === a.id)).toMatchObject({ cardRef: out.results[0].cardRef });
    expect(done.find((i) => i.id === c.id)).toMatchObject({ cardRef: out.results[2].cardRef });
    expect((await list('?status=dropped')).map((i) => i.id)).toContain(b.id);
  });
});

describe('agent suggestions and the daily report', () => {
  let cardRow: any;
  let agent: any;
  const shift = () => ({ id: randomUUID(), card_id: cardRow.id, agent_id: agent.id, kind: 'build' });
  const suggest = (s: any, params: unknown) => addBacklogSuggestionRpc(w.t.app.ctx, s, params);

  beforeAll(async () => {
    cardRow = await w.card({ title: 'Working card' });
    agent = await w.hire('Bea', 'builder', 'senior');
    agent = (await q('SELECT id, name FROM agents WHERE id=$1', [agent.id ?? agent.agentId]))[0]!;
  });

  it('records the agent and the card from the shift; no card, desk item or BA task', async () => {
    const before = await counts();
    const s = shift();
    const [ok, result] = await suggest(s, { title: 'Follow-up found', priority: 'low', tags: ['Refactor'] });
    expect(ok).toBe(true);
    expect((result as any).added).toBe(true);
    const items = await list('?source=agent');
    const item = items.find((i) => i.title === 'Follow-up found');
    expect(item).toMatchObject({
      status: 'open',
      priority: 'low',
      tags: ['refactor'],
      source: { kind: 'agent', agentName: agent.name, cardRef: cardRow.ref },
    });
    expect(await counts()).toEqual(before);
  });

  it('refuses params that name a source, a status or an id; a duplicate open title; and more than 5 per shift', async () => {
    const s = shift();
    for (const bad of [
      { source: 'owner' },
      { status: 'done' },
      { itemId: randomUUID() },
      { flagged: true },
    ]) {
      const [ok, , error] = await suggest(s, { title: 'Bad', ...bad });
      expect(ok).toBe(false);
      expect(error).toContain('only add suggestions');
    }
    expect((await suggest(s, { title: 'Same title' }))[0]).toBe(true);
    const [, dup] = await suggest(shift(), { title: 'same TITLE' });
    expect((dup as any).added).toBe(false);
    for (let i = 0; i < 4; i++) expect((await suggest(s, { title: `Many ${i}` }))[0]).toBe(true);
    const [ok, , error] = await suggest(s, { title: 'One too many' });
    expect(ok).toBe(false);
    expect(error).toContain('at most 5');
  });

  it('refuses a shift with no card', async () => {
    const [ok, , error] = await suggest(
      { id: randomUUID(), card_id: null, agent_id: agent.id },
      { title: 'No card' },
    );
    expect(ok).toBe(false);
    expect(error).toContain('no card');
  });

  it('the daily report lists new suggestions once, and leaves the section out when there are none', async () => {
    // Everything suggested so far goes into the first report.
    const first = await w.card({ title: 'Report card' });
    expect(first.id).toBeTruthy();
    await appoint(w);
    const post = (report: string) =>
      postCeoReport(w.t.app.ctx, w.t.app.ctx.pool, orgId, {
        report,
        localDate: '2026-10-21',
        fallback: true,
      });
    const [ok1] = await suggest(shift(), { title: 'Before the first report', priority: 'high' });
    expect(ok1).toBe(true);
    await post('First report');
    const body1 = (
      await q(`SELECT body FROM desk_items WHERE subkind='ceo_report' ORDER BY created_at DESC LIMIT 1`)
    )[0]!.body as string;
    expect(body1).toContain('## New backlog suggestions from agents');
    expect(body1).toContain('Before the first report (High)');
    expect(body1).toContain(`suggested by ${agent.name} on ${cardRow.ref}`);
    expect(await q(`SELECT 1 FROM events WHERE type='BacklogSuggestionsReported'`)).toHaveLength(1);

    // Nothing new: no section, no event.
    await post('Second report');
    const body2 = (
      await q(`SELECT body FROM desk_items WHERE subkind='ceo_report' ORDER BY created_at DESC LIMIT 1`)
    )[0]!.body as string;
    expect(body2).not.toContain('New backlog suggestions');
    expect(await q(`SELECT 1 FROM events WHERE type='BacklogSuggestionsReported'`)).toHaveLength(1);

    // One new suggestion: only that one is listed.
    await suggest(shift(), { title: 'After the first report' });
    await post('Third report');
    const body3 = (
      await q(`SELECT body FROM desk_items WHERE subkind='ceo_report' ORDER BY created_at DESC LIMIT 1`)
    )[0]!.body as string;
    expect(body3).toContain('After the first report');
    expect(body3).not.toContain('Before the first report');
  });
});

describe('the CEO verbs', () => {
  let r: FakeRunner;
  let shiftId: string;
  beforeAll(async () => {
    r = await w.connectRunner({ capabilities: ['ceo:1'] });
    await appoint(w);
    await wakeNow(w);
    shiftId = (await startCeoShift(w, r)).shiftId;
  });
  afterAll(() => r.close());

  const result = (resp: any) => {
    expect(resp.ok, JSON.stringify(resp)).toBe(true);
    return resp.result;
  };
  const ceoList = async (params: Record<string, unknown> = {}) =>
    result(await ceo(r, shiftId, { op: 'backlog', sub: 'list', ...params }));

  it('backlog list: default Open, all projects, filters and search; one line per item', async () => {
    const open = await add('CEO list open', { tags: ['ceolist'], priority: 'low' });
    const gone = await add('CEO list dropped', { tags: ['ceolist'] });
    await call('POST', `/api/backlog/${gone.id}/drop`);
    const def = await ceoList({ tag: ['ceolist'] });
    expect(def.items.map((i: any) => i.id)).toEqual([open.id]);
    expect(def.text).toContain(open.id);
    expect(def.text).toContain('[Open] Low ceolist "CEO list open" (owner)');
    expect((await ceoList({ tag: ['ceolist'], status: ['dropped'] })).items.map((i: any) => i.id)).toEqual([
      gone.id,
    ]);
    expect((await ceoList({ project: 'TOY', q: 'ceo list open' })).items.map((i: any) => i.id)).toEqual([
      open.id,
    ]);
    expect((await ceoList({ project: 'NOPE', tag: ['ceolist'] })).items).toEqual([]);
  });

  it('backlog-add then backlog-update (flag, fields, drop), seen in the web list', async () => {
    const added = result(
      await act(
        r,
        shiftId,
        'backlog-add',
        { project: 'TOY', title: 'From the CEO', tags: ['ui'], priority: 'high' },
        { key: 'b-add' },
      ),
    );
    expect(added.status, JSON.stringify(added)).toBe('executed');
    const id = added.result.itemId as string;
    expect((await list('?tag=ui')).find((i) => i.id === id)).toMatchObject({
      source: { kind: 'owner' },
      priority: 'high',
    });
    const flagged = result(
      await act(
        r,
        shiftId,
        'backlog-update',
        { item: id, flagged: true, title: 'Renamed' },
        { key: 'b-flag' },
      ),
    );
    expect(flagged.status).toBe('executed');
    expect((await list('?flagged=true')).find((i) => i.id === id)).toMatchObject({ title: 'Renamed' });
    const mixed = result(
      await act(r, shiftId, 'backlog-update', { item: id, drop: true, title: 'x' }, { key: 'b-mixed' }),
    );
    expect(mixed.status).toBe('refused');
    const dropped = result(
      await act(r, shiftId, 'backlog-update', { item: id, drop: true }, { key: 'b-drop' }),
    );
    expect(dropped.status).toBe('executed');
    expect((await list('?status=dropped')).map((i) => i.id)).toContain(id);
    const sendDropped = result(
      await act(r, shiftId, 'backlog-send', { item: id }, { key: 'b-send-dropped' }),
    );
    expect(sendDropped.status).toBe('refused');
  });

  it('backlog-send by filters sends exactly the flagged ui items; a bare send is refused', async () => {
    await w.hire('Bob', 'ba', 'senior').catch(() => undefined);
    const hit = await add('Flagged ui', { tags: ['sendui'], flagged: true });
    await add('Unflagged ui', { tags: ['sendui'] });
    await add('Flagged other', { tags: ['other'], flagged: true });
    const bare = result(await act(r, shiftId, 'backlog-send', {}, { key: 'b-bare' }));
    expect(bare.status).toBe('refused');
    const sent = result(
      await act(r, shiftId, 'backlog-send', { tag: ['sendui'], flagged: true }, { key: 'b-send' }),
    );
    expect(sent.status, JSON.stringify(sent)).toBe('executed');
    expect(sent.result.results).toHaveLength(1);
    expect(sent.message).toContain('<- Flagged ui');
    const done = (await list('?status=done')).find((i) => i.id === hit.id);
    expect(done).toMatchObject({ status: 'done', cardRef: sent.result.results[0].cardRef });
    expect((await list('?tag=sendui')).map((i) => i.title)).toEqual(['Unflagged ui']);
  });
});
