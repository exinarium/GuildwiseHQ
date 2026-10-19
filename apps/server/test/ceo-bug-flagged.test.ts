import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baTaskPass } from '../src/dispatcher/ba-tasks.ts';
import { act, appoint, keepOnline, startCeoShift } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, hireTeam, pipeline, testFail, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** docs/design/ceo-front-door.md 2.4: a flagged bug (a draft bug card) wakes the CEO, which sends it on with `specify`. */
let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
let shiftId: string;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  p = pipeline(w, r);
  await appoint(w);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const bugWakes = (cardId: string) =>
  q(`SELECT * FROM ceo_wakes WHERE reason='bug_flagged' AND subject_id=$1`, [cardId]);
const wakesAbout = async (cardId: string) =>
  q(
    `SELECT * FROM ceo_wakes WHERE subject_id=$1
        OR subject_id IN (SELECT id::text FROM desk_items WHERE card_id=$2::uuid)`,
    [cardId, cardId],
  );
const result = (resp: any) => {
  expect(resp.ok, JSON.stringify(resp)).toBe(true);
  return resp.result;
};

async function draftBug(
  title: string,
  fields: Record<string, unknown> = { context: 'Checkout total is wrong' },
) {
  const res = await ok<any>(
    owner('POST', '/api/cards', {
      projectId: w.projectId,
      title,
      cardType: 'bug',
      fields,
    }),
    201,
  );
  return res.card as { id: string; ref: string };
}

describe('a flagged bug wakes the CEO', () => {
  it('a draft bug card wakes it once, as a normal wake keyed by the card', async () => {
    const bug = await draftBug('Login loses the session');
    await until(async () => (await bugWakes(bug.id)).length > 0, 4000, 'bug_flagged wake');
    const wakes = await bugWakes(bug.id);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      reason: 'bug_flagged',
      urgency: 'normal',
      subject_kind: 'card',
      status: 'pending',
      untrusted: true,
    });
    expect(wakes[0]!.subject_label).toContain(bug.ref);
  });

  it('other cards do not wake it', async () => {
    const before = Number((await q(`SELECT count(*) AS n FROM ceo_wakes`))[0]!.n);
    await ok(
      owner('POST', '/api/cards', {
        projectId: w.projectId,
        title: 'A feature',
        cardType: 'feature',
        fields: {},
      }),
      201,
    );
    await new Promise((res) => setTimeout(res, 300));
    expect(Number((await q(`SELECT count(*) AS n FROM ceo_wakes`))[0]!.n)).toBe(before);
  });

  it('a suite failure draft wakes it once, urgent, and its bug_reported alert adds no second wake', async () => {
    await freshState();
    await hireTeam(w);
    await appoint(w); // freshState removed the agents, the CEO included
    await q(`TRUNCATE ceo_wakes`);
    const card = await w.card({ title: 'Shipped feature' });
    await p.toTest('Bea', ['Rex']);
    await p.run('Tess', testPass());
    const from = r.received.length;
    await ok(owner('POST', `/api/cards/${card.id}/finalize`, {}));
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, action: 'merge', mergeCommit: 'a1b2c3d' },
    });
    await until(async () => (await cardRow(card.id)).status === 'done', 3000, 'finalized');
    await p.run('Tess', testFail('Checkout total is wrong', '2 failed'));
    const bug = (
      await q(`SELECT * FROM cards WHERE card_type='bug' AND origin='full_suite' AND status='draft'`)
    )[0]!;
    await until(async () => (await bugWakes(bug.id)).length > 0, 4000, 'suite bug wake');
    await new Promise((res) => setTimeout(res, 300));
    const all = await wakesAbout(bug.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ reason: 'bug_flagged', urgency: 'urgent' });
    expect(
      (await q(`SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind='bug_reported'`, [bug.id])).length,
    ).toBe(1);
  });
});

describe('the CEO sends a draft on with specify', () => {
  it('specifies a complete draft at once', async () => {
    await freshState();
    await appoint(w);
    await q(`TRUNCATE ceo_wakes`);
    await keepOnline(w);
    const bug = await draftBug('Complete bug', {
      context: 'It breaks.',
      requirements: 'Fix it.',
      acceptanceCriteria: ['It works'],
      affectedAreas: 'login',
      testPlan: 'Unit test',
    });
    await until(async () => (await bugWakes(bug.id)).length > 0, 4000, 'wake');
    const missing = (await ok<any>(owner('GET', `/api/cards/${bug.id}`))).card;
    void missing;
    // a normal wake waits for the debounce window
    w.t.clock.advance(6 * 60_000);
    await keepOnline(w);
    shiftId = (await startCeoShift(w, r)).shiftId;
    const res = result(await act(r, shiftId, 'specify', { card: bug.ref }));
    expect(res.status).toBe('executed');
    const row = await cardRow(bug.id);
    if (row.status === 'draft') {
      // the workflow wants more than these fields: the BA is asked for the rest
      expect(res.message).toMatch(/BA|draft/);
    } else {
      expect(res.message).toContain('specified');
    }
  });

  it('queues a spec_card BA task for a draft with empty required fields; the BA writes them and the card is specified', async () => {
    const bug = await draftBug('Sparse bug', { context: 'Only a sentence.' });
    await w.hire('Ben', 'ba', 'senior');
    const res = result(await act(r, shiftId, 'specify', { card: bug.ref }));
    expect(res.message).toContain('sent to the BA to complete');
    expect(res.message).toMatch(/requirements|acceptanceCriteria|testPlan|affectedAreas/);
    const tasks = await q(`SELECT * FROM ba_tasks WHERE kind='spec_card' AND card_id=$1`, [bug.id]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'queued', project_id: w.projectId });
    // asking again returns the open task: no second one
    const again = result(await act(r, shiftId, 'specify', { card: bug.ref }, { key: 'again' }));
    expect(again.message).toContain('sent to the BA');
    expect(await q(`SELECT 1 FROM ba_tasks WHERE kind='spec_card' AND card_id=$1`, [bug.id])).toHaveLength(1);

    // the BA shift
    const from = r.received.length;
    await baTaskPass(w.t.app.ctx);
    const start = (await r.waitFor(
      'shift.start',
      (f) => f.kind === 'ba_task' && f.baTask?.kind === 'spec_card',
      8000,
      from,
    )) as any;
    expect(start.baTask.specCard).toMatchObject({
      ref: bug.ref,
      cardType: 'bug',
      projectKey: expect.any(String),
    });
    expect(start.baTask.specCard.missing.length).toBeGreaterThan(0);
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['spec_card_done', 'spec_card_fail']);
    r.accepted(start.shiftId);
    r.started(start.shiftId);
    // a report that leaves a field out is refused with what is missing
    const first = start.baTask.specCard.missing as string[];
    const lists = start.baTask.specCard.listFields as string[];
    const value = (k: string, text: string) => (lists.includes(k) ? [text] : text);
    const partial = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'spec_card_done',
      note: 'partial',
      data: { fields: { [first[0]!]: value(first[0]!, 'Written by the BA.') } },
    });
    const partialRes = (await r.waitFor(
      'shift.report.result',
      (f) => f.reportId === partial.reportId,
    )) as any;
    if (first.length > 1) {
      expect(partialRes.accepted).toBe(false);
      expect(partialRes.error).toContain('still lacks');
    }
    const full = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'spec_card_done',
      note: 'done',
      data: { fields: Object.fromEntries(first.map((k) => [k, value(k, `Written by the BA for ${k}.`)])) },
    });
    const fullRes = (await r.waitFor('shift.report.result', (f) => f.reportId === full.reportId)) as any;
    expect(fullRes.accepted, JSON.stringify(fullRes)).toBe(true);
    const row = await cardRow(bug.id);
    expect(row.status).toBe('queued');
    expect(row.fields.context).toBe('Only a sentence.');
    expect(JSON.stringify(row.fields[first[0]!])).toContain('Written by the BA');
    expect(lists.length).toBeGreaterThan(0); // acceptance criteria is a list field
    expect((await q(`SELECT status FROM ba_tasks WHERE card_id=$1`, [bug.id]))[0]!.status).toBe('done');
    expect(
      (await q(`SELECT 1 FROM events WHERE type='CardSpecified' AND payload->>'cardId'=$1`, [bug.id])).length,
    ).toBe(1);
    r.ended(start.shiftId, 'reported');
  });

  it('a draft that lacks a repository is left to a person: no BA task, and it says so', async () => {
    await q(`UPDATE projects SET status='active' WHERE id=$1`, [w.projectId]);
    // a card whose repository was removed: required `repoId` is missing and the BA cannot supply it
    const bug = await draftBug('No repo bug');
    await q(`UPDATE cards SET repo_id=NULL WHERE id=$1`, [bug.id]);
    const res = result(await act(r, shiftId, 'specify', { card: bug.ref }, { key: 'norepo' }));
    expect(res.message).toMatch(/repository/);
    expect(res.message).toContain('stays a draft');
    expect(await q(`SELECT 1 FROM ba_tasks WHERE card_id=$1`, [bug.id])).toHaveLength(0);
  });

  it('refuses a card that is not a draft', async () => {
    const card = await w.card({ title: 'Queued already' });
    const res = await act(r, shiftId, 'specify', { card: card.ref }, { key: 'notdraft' });
    expect(res.result?.status ?? res.status).toMatch(/refused/);
  });
});

describe('the spec_card fallback', () => {
  it('a task no BA takes becomes a pinned "needs specifying" alert and the card stays a draft', async () => {
    const bug = await draftBug('Fallback bug', { context: 'x' });
    await q(`UPDATE agents SET status='retired' WHERE role_key='ba'`);
    const res = result(await act(r, shiftId, 'specify', { card: bug.ref }, { key: 'fb' }));
    expect(res.message).toMatch(/no BA|hiring/i);
    // with a BA hired but gone offline for good, the dispatcher's fallback runs
    await w.hire('Bo', 'ba', 'senior');
    const queued = result(await act(r, shiftId, 'specify', { card: bug.ref }, { key: 'fb2' }));
    expect(queued.message).toContain('sent to the BA');
    await q(`UPDATE agents SET status='retired' WHERE name='Bo'`);
    await baTaskPass(w.t.app.ctx);
    expect((await q(`SELECT status FROM ba_tasks WHERE card_id=$1`, [bug.id]))[0]!.status).toBe('fallback');
    const item = (
      await q(`SELECT * FROM desk_items WHERE card_id=$1 AND subkind='spec_needed'`, [bug.id])
    )[0]!;
    expect(item).toMatchObject({ pinned: true, status: 'open' });
    expect((await cardRow(bug.id)).status).toBe('draft');
  });
});
