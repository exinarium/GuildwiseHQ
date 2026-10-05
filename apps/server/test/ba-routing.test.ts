import { randomUUID } from 'node:crypto';
import { REPORTER, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner();
  await w.hire('Ben', 'ba', 'senior');
  await w.hire('Bea', 'builder', 'junior');
  await w.hire('Sam', 'builder', 'senior');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const h = shiftHelpers;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const SYSTEM = { kind: 'system' as const, id: null };
const dispatcher = () => w.t.app.ctx.services.dispatcher;
const reporter = () => w.t.app.ctx.services.reporter;
const setRouting = (on: boolean) => ok(owner('PUT', '/api/reporting', { routeViaBa: on }));
const deskIds = async () => ((await ok<any>(owner('GET', '/api/desk'))).items as any[]).map((i) => i.id);
const deskItem = async (id: string) =>
  ((await ok<any>(owner('GET', '/api/desk'))).items as any[]).find((i) => i.id === id);
const row = async (id: string) => (await q('SELECT * FROM desk_items WHERE id=$1', [id]))[0]!;

async function clean() {
  // Like freshState(), but the hired agents stay.
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, thread_messages, desk_items,
       card_blockers, ledger_entries, ba_tasks, ba_signals, runner_commands, runner_inbox CASCADE`,
  );
  await online();
}
/** The fake runner sends no heartbeats: keep the workstation's presence fresh for the BA availability check. */
const online = () =>
  q(`UPDATE workstations SET connected=true, last_seen_at=$2 WHERE id=$1`, [
    w.workstationId,
    w.t.clock.now(),
  ]);

/** An alert the system raises (a non-pinned `bug_reported`), through the event store like every emitter. */
async function alert(title: string, over: Record<string, unknown> = {}) {
  const id = randomUUID();
  await seed(w, [
    {
      streamId: streamId.desk(id),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId: id,
          kind: 'alert',
          subkind: 'bug_reported',
          title,
          body: `${title} body`,
          projectId: w.projectId,
          askedBy: { kind: 'system' },
          ...over,
        },
      },
      actor: SYSTEM,
      scope: scope(),
    },
  ]);
  return id;
}

async function baShift(from: number, kind: string) {
  const start = (await r.waitFor(
    'shift.start',
    (f) => f.kind === 'ba_task' && f.baTask?.kind === kind,
    5000,
    from,
  )) as any;
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='running'`, [start.shiftId]))[0],
    3000,
    'shift running',
  );
  return start;
}
const baReport = async (shiftId: string, outcomeId: string, data: unknown) => {
  const { reportId } = r.report(shiftId, { kind: 'outcome', outcomeId, note: outcomeId, data });
  return (await r.waitFor('shift.report.result', (f) => f.reportId === reportId)) as any;
};
const tasks = (kind: string) => q(`SELECT * FROM ba_tasks WHERE kind=$1 ORDER BY created_at`, [kind]);

describe('routing is a per-org setting, default on', () => {
  it('new organizations route through the BA; the test helper turns it off for the other suites', async () => {
    const fresh = await w.t.app.ctx.pool.query(`SELECT reporting FROM users WHERE id=$1`, [w.owner.id]);
    expect(fresh.rows[0].reporting).toEqual({ routeViaBa: false });
    const body = await ok<any>(owner('GET', '/api/reporting'));
    expect(body).toMatchObject({
      routeViaBa: false,
      dailyAt: '08:00',
      timezone: null,
      effectiveTimezone: 'UTC',
    });
    // a user with no stored preference gets the defaults (routing on, 08:00)
    const other = await w.t.userSession(`other-${randomUUID().slice(0, 6)}@example.test`);
    await q(`UPDATE users SET reporting='{}' WHERE id=$1`, [other.id]);
    expect(await ok<any>(w.t.req('GET', '/api/reporting', { cookie: other.cookie }))).toMatchObject({
      routeViaBa: true,
      dailyAt: '08:00',
    });
    expect((await setRouting(true)).routeViaBa).toBe(true);
    expect((await ok<any>(owner('PUT', '/api/reporting', { dailyAt: '07:30' }))).dailyAt).toBe('07:30');
    await ok(owner('PUT', '/api/reporting', { dailyAt: '08:00' }));
    expect((await owner('PUT', '/api/reporting', { dailyAt: '25:00' })).status).toBe(400);
    expect((await owner('PUT', '/api/reporting', {})).status).toBe(400);
  });

  it('the manager time zone is a validated user setting', async () => {
    expect((await owner('PUT', '/api/auth/timezone', { timezone: 'Mars/Olympus' })).status).toBe(400);
    const me = await ok<any>(owner('PUT', '/api/auth/timezone', { timezone: 'Africa/Johannesburg' }));
    expect(me.user.timezone).toBe('Africa/Johannesburg');
    expect((await ok<any>(owner('GET', '/api/reporting'))).effectiveTimezone).toBe('Africa/Johannesburg');
  });
});

describe('non-urgent items are held for the BA', () => {
  it('with routing off an alert is on the desk at once and no task is queued', async () => {
    await clean();
    await setRouting(false);
    const id = await alert('direct');
    expect(await deskIds()).toContain(id);
    expect((await row(id)).triage).toBe('none');
    expect(await tasks('desk_triage')).toHaveLength(0);
    await setRouting(true);
  });

  it('is held and hidden, then the BA passes one (with a note), dismisses one and merges one', async () => {
    await clean();
    const keep = await alert('Bug filed: login broken');
    const noise = await alert('Bug filed: typo in footer');
    const dup = await alert('Bug filed: login broken again');
    expect(await deskIds()).toEqual([]);
    expect((await row(keep)).triage).toBe('pending');
    // one task for the burst, with all three
    const queued = await tasks('desk_triage');
    expect(queued).toHaveLength(1);
    expect([...queued[0]!.desk_item_ids].sort()).toEqual([keep, noise, dup].sort());

    const from = r.received.length;
    await dispatcher().run();
    const start = await baShift(from, 'desk_triage');
    expect(start.baTask.reporter.items.map((i: any) => i.title).sort()).toEqual([
      'Bug filed: login broken',
      'Bug filed: login broken again',
      'Bug filed: typo in footer',
    ]);
    expect(start.baTask.reporter.triageWindowMinutes).toBe(REPORTER.triageWindowMinutes);
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['triage_done']);

    // a decision about an item that is not part of the task, and a merge into nothing, are refused
    const bad = await baReport(start.shiftId, 'triage_done', {
      decisions: [{ itemId: randomUUID(), action: 'pass' }],
    });
    expect(bad.accepted).toBe(false);
    const badMerge = await baReport(start.shiftId, 'triage_done', {
      decisions: [{ itemId: dup, action: 'merge', into: randomUUID() }],
    });
    expect(badMerge.accepted).toBe(false);

    const res = await baReport(start.shiftId, 'triage_done', {
      decisions: [
        { itemId: keep, action: 'pass', note: 'Real: 3 users hit it today.' },
        { itemId: noise, action: 'dismiss', note: 'Cosmetic, already on the board' },
        { itemId: dup, action: 'merge', into: keep, note: 'Same bug' },
      ],
    });
    expect(res.accepted).toBe(true);
    expect((await tasks('desk_triage'))[0]!.status).toBe('done');

    const shown = await deskItem(keep);
    expect(shown).toMatchObject({ triage: 'passed', baNote: 'Real: 3 users hit it today.' });
    expect(await deskIds()).toEqual([keep]);
    expect(await row(noise)).toMatchObject({ status: 'dismissed', triage: 'dismissed' });
    expect(await row(dup)).toMatchObject({ status: 'superseded', triage: 'merged', superseded_by: keep });
  });

  it('items the BA leaves out reach the manager unchanged', async () => {
    await clean();
    const a = await alert('left out');
    const b = await alert('decided');
    const from = r.received.length;
    await dispatcher().run();
    const start = await baShift(from, 'desk_triage');
    await baReport(start.shiftId, 'triage_done', { decisions: [{ itemId: b, action: 'pass' }] });
    expect((await row(a)).triage).toBe('released');
    expect((await deskIds()).sort()).toEqual([a, b].sort());
    expect((await row(a)).title).toBe('left out');
  });

  it('only alerts can be dismissed or merged: a question that needs the manager cannot disappear', async () => {
    await clean();
    const a = await alert('held');
    // A pinned item is urgent and never held, so it cannot be part of a triage task; forge the case directly.
    const pinned = await alert('pinned one', { pinned: true });
    await q(`UPDATE desk_items SET triage='pending' WHERE id=$1`, [pinned]);
    await q(`UPDATE ba_tasks SET desk_item_ids = desk_item_ids || $1::uuid[] WHERE kind='desk_triage'`, [
      [pinned],
    ]);
    const from = r.received.length;
    await dispatcher().run();
    const start = await baShift(from, 'desk_triage');
    const res = await baReport(start.shiftId, 'triage_done', {
      decisions: [{ itemId: pinned, action: 'dismiss' }],
    });
    expect(res.accepted).toBe(false);
    expect(res.error).toContain('needs the manager');
    await baReport(start.shiftId, 'triage_done', { decisions: [{ itemId: a, action: 'pass' }] });
  });

  it('a BA that does not get to it in time: the item reaches the manager unchanged at the deadline', async () => {
    await clean();
    const id = await alert('slow');
    expect(await deskIds()).toEqual([]);
    w.t.clock.advance((REPORTER.triageWindowMinutes - 1) * 60_000);
    await reporter().run();
    expect(await deskIds()).toEqual([]);
    w.t.clock.advance(2 * 60_000);
    await online();
    const out = await reporter().run();
    expect(out.released).toBe(1);
    expect(await deskIds()).toEqual([id]);
    expect(await row(id)).toMatchObject({ triage: 'released', status: 'open', title: 'slow' });
    // a late dismiss from the BA cannot take it away again; only context is added
    const from = r.received.length;
    await dispatcher().run();
    const start = await baShift(from, 'desk_triage');
    const res = await baReport(start.shiftId, 'triage_done', {
      decisions: [{ itemId: id, action: 'dismiss', note: 'late context' }],
    });
    expect(res.accepted).toBe(true);
    expect(await row(id)).toMatchObject({ status: 'open', triage: 'released', ba_note: 'late context' });
  });

  it('with no BA reachable nothing is held, and a stalled task is done by the server', async () => {
    await clean();
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    const id = await alert('nobody home');
    expect((await row(id)).triage).toBe('none');
    expect(await deskIds()).toEqual([id]);
    expect(await tasks('desk_triage')).toHaveLength(0);
    await online();

    // held while the BA is reachable, then the BA goes silent: the deadline releases it, the task falls back
    const held = await alert('held then abandoned');
    expect((await row(held)).triage).toBe('pending');
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    w.t.clock.advance(16 * 60_000);
    await reporter().run();
    await dispatcher().run();
    expect((await row(held)).triage).toBe('released');
    expect((await tasks('desk_triage'))[0]!.status).toBe('fallback');
    await online();
  });
});

describe('urgent items go straight to the manager; the BA annotates afterwards', () => {
  it('pinned alerts, approvals and blocking questions are never held', async () => {
    await clean();
    const pinned = await alert('Second tester shortage', { pinned: true });
    const approval = await alert('Approve the thing', { kind: 'approval', subkind: 'definition' });
    expect((await row(pinned)).triage).toBe('none');
    expect((await row(approval)).triage).toBe('none');
    expect((await deskIds()).sort()).toEqual([pinned, approval].sort());
    expect(await tasks('desk_triage')).toHaveLength(0);
    // one note task for the burst
    const notes = await tasks('urgent_note');
    expect(notes).toHaveLength(1);
    expect([...notes[0]!.desk_item_ids].sort()).toEqual([pinned, approval].sort());

    const from = r.received.length;
    await dispatcher().run();
    const start = await baShift(from, 'urgent_note');
    expect(start.baTask.reporter.items.every((i: any) => i.held === false)).toBe(true);
    const res = await baReport(start.shiftId, 'notes_done', {
      notes: [{ itemId: pinned, note: 'Second bottleneck this week; hire a tester.', related: [approval] }],
    });
    expect(res.accepted).toBe(true);
    expect((await deskItem(pinned)).baNote).toContain('hire a tester');
    expect((await deskItem(approval)).baNote).toBeNull();
  });

  it('a blocking question skips the peer and the BA hop and is on the desk at once', async () => {
    await clean();
    const from = r.received.length;
    const card = await w.card({ title: 'Needs an answer' });
    const hh = h(w);
    const start = await hh.dispatchTo(r, 'Bea', from);
    await hh.startShift(r, start);
    const res = (await hh.report(r, start.shiftId, {
      kind: 'question',
      text: 'Tabs or spaces for the formatter?',
      options: ['tabs', 'spaces'],
      doing: 'formatting',
      blocking: true,
    })) as any;
    expect(res.accepted).toBe(true);
    expect(res.message).toContain("manager's desk");
    const it = (await q('SELECT * FROM desk_items WHERE card_id=$1', [card.id]))[0]!;
    expect(it).toMatchObject({ routed_to: 'manager', blocking: true, triage: 'none' });
    expect(await deskIds()).toContain(it.id);
    // the BA is asked for a note
    expect((await tasks('urgent_note')).at(-1)!.desk_item_ids).toContain(it.id);
    r.ended(start.shiftId, 'reported');
  });

  it('a non-blocking question starts at the BA instead of the senior peer', async () => {
    await clean();
    const from = r.received.length;
    await w.card({ title: 'Small doubt' });
    const hh = h(w);
    const start = await hh.dispatchTo(r, 'Bea', from);
    await hh.startShift(r, start);
    const res = (await hh.report(r, start.shiftId, {
      kind: 'question',
      text: 'Is the footer copyright year dynamic?',
      options: [],
      doing: 'reading',
      blocking: false,
    })) as any;
    expect(res.accepted).toBe(true);
    const it = (await q(`SELECT * FROM desk_items WHERE kind='question'`))[0]!;
    const ben = (await q(`SELECT id FROM agents WHERE name='Ben'`))[0]!;
    expect(it).toMatchObject({ routed_to: 'agent', routed_agent_id: ben.id });
    expect(await deskIds()).toEqual([]);
    r.ended(start.shiftId, 'reported');
  });

  it('with routing off the old chain (peer first) is unchanged', async () => {
    await clean();
    await setRouting(false);
    const from = r.received.length;
    await w.card({ title: 'Old chain' });
    const hh = h(w);
    const start = await hh.dispatchTo(r, 'Bea', from);
    await hh.startShift(r, start);
    await hh.report(r, start.shiftId, {
      kind: 'question',
      text: 'Does the old chain still ask Sam?',
      options: [],
      doing: 'reading',
      blocking: true,
    });
    const sam = (await q(`SELECT id FROM agents WHERE name='Sam'`))[0]!;
    const it = (await q(`SELECT * FROM desk_items WHERE kind='question'`))[0]!;
    expect(it).toMatchObject({ routed_to: 'agent', routed_agent_id: sam.id });
    r.ended(start.shiftId, 'reported');
    await setRouting(true);
  });
});

describe('rebuild', () => {
  it('replaying the events reproduces the routing state (the decision is in the event)', async () => {
    await online();
    const one = await alert('rebuilt one');
    const two = await alert('rebuilt two', { pinned: true });
    const snap = async () => ({
      desk: (
        await q(`SELECT to_jsonb(t)::text AS j FROM desk_items t WHERE id = ANY($1::uuid[]) ORDER BY id`, [
          [one, two],
        ])
      ).map((x) => x.j),
      tasks: (
        await q(
          `SELECT to_jsonb(t)::text AS j FROM ba_tasks t WHERE desk_item_ids && $1::uuid[] ORDER BY id`,
          [[one, two]],
        )
      ).map((x) => x.j),
    });
    const before = await snap();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
    expect(before.desk.join()).toContain('"triage": "pending"');
    expect(before.tasks).toHaveLength(2);
    expect(PROJECTION_TABLES).toContain('ba_signals');
  });
});
