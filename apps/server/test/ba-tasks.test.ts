import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { phasePass } from '../src/dispatcher/phases.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const scope = () => ({ orgId: w.owner.id, projectId: w.projectId, audience: 'project' as const });
const SYSTEM = { kind: 'system' as const, id: null };
const dispatcher = () => w.t.app.ctx.services.dispatcher;
const phaseStatus = async (id: string) => (await q('SELECT status FROM phases WHERE id=$1', [id]))[0]?.status;
const eventsOf = async (type: string) =>
  (await q('SELECT payload, actor_kind FROM events WHERE type=$1 ORDER BY seq', [type])) as any[];

/** A phase whose single card is merged: the pass completes it and queues the BA's report task. */
async function completedPhase(name: string, followups: unknown[] = []) {
  const phase = await ok<any>(owner('POST', `/api/projects/${w.projectId}/phases`, { name, followups }), 201);
  const card = await w.card({ title: `${name} card`, specify: false });
  await ok(owner('PUT', `/api/cards/${card.id}/phase`, { phaseId: phase.id }));
  await seed(w, [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'CardFinalized',
        payload: {
          cardId: card.id,
          action: 'merge',
          resultRef: { mergeCommit: 'abc1234567' },
          toStage: 'done',
        },
      },
      actor: SYSTEM,
      scope: scope(),
    },
  ]);
  await phasePass(w.t.app.ctx);
  expect(await phaseStatus(phase.id)).toBe('reporting');
  const task = (
    await q(`SELECT * FROM ba_tasks WHERE phase_id=$1 AND kind='phase_report' ORDER BY created_at DESC`, [
      phase.id,
    ])
  )[0]!;
  return { phase, card, task };
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
const report = async (shiftId: string, rep: Record<string, unknown>) => {
  const { reportId } = r.report(shiftId, rep);
  return (await r.waitFor('shift.report.result', (f) => f.reportId === reportId)) as any;
};
const endShift = async (shiftId: string, outcome = 'reported') => {
  r.ended(shiftId, outcome);
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [shiftId]))[0],
    3000,
    'shift ended',
  );
};

describe('no BA to take the task: the server writes a template report', () => {
  it('with no BA hired the report is posted at once, marked as generated', async () => {
    const { phase, task } = await completedPhase('No BA', [{ kind: 'regression' }]);
    await dispatcher().runPass();
    expect(await phaseStatus(phase.id)).toBe('awaiting_approval');
    expect((await q('SELECT status FROM ba_tasks WHERE id=$1', [task.id]))[0]?.status).toBe('fallback');
    const row = (await q('SELECT report, report_desk_item_id FROM phases WHERE id=$1', [phase.id]))[0]!;
    expect(row.report).toContain('Your BA was not available; this summary was generated.');
    expect(row.report).toContain('Regression run (web)');
    const item = (
      await q('SELECT kind, subkind, title, asked_by_kind FROM desk_items WHERE id=$1', [
        row.report_desk_item_id,
      ])
    )[0]!;
    expect(item).toMatchObject({ kind: 'approval', subkind: 'phase_done', asked_by_kind: 'system' });
    expect(item.title).toBe(`${phase.ref} No BA is done: approve 1 follow-up?`);
    expect(((await eventsOf('PhaseReportPosted')).at(-1) as any).payload.by).toMatchObject({
      kind: 'system',
    });
  });

  it('a phase with no follow-ups gets an acknowledge notice instead of an approval', async () => {
    const { phase } = await completedPhase('No followups');
    await dispatcher().runPass();
    const row = (await q('SELECT report_desk_item_id FROM phases WHERE id=$1', [phase.id]))[0]!;
    const item = (await q('SELECT kind, title FROM desk_items WHERE id=$1', [row.report_desk_item_id]))[0]!;
    expect(item).toMatchObject({ kind: 'alert', title: `${phase.ref} No followups is done` });
    await ok(owner('POST', `/api/desk/${row.report_desk_item_id}/resolve`, { resolution: 'acknowledged' }));
    expect(await phaseStatus(phase.id)).toBe('done');
  });
});

describe('a BA that is offline', () => {
  it('waits for it for 15 minutes, then the server does the task', async () => {
    await w.hire('Ben', 'ba', 'senior');
    r.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'offline');
    await until(
      async () =>
        !(await q('SELECT connected FROM workstations WHERE id=$1', [w.workstationId]))[0]?.connected,
      3000,
      'disconnect recorded',
    );
    const { phase } = await completedPhase('Offline BA');
    await dispatcher().runPass();
    expect(await phaseStatus(phase.id)).toBe('reporting');
    w.t.clock.advance(14 * 60_000);
    await dispatcher().runPass();
    expect(await phaseStatus(phase.id)).toBe('reporting');
    w.t.clock.advance(2 * 60_000);
    await dispatcher().runPass();
    expect(await phaseStatus(phase.id)).toBe('awaiting_approval');
    r = await w.connectRunner();
  });
});

describe('the BA takes a task', () => {
  it('a phase_report shift carries the phase; the report lands on the desk as the BA', async () => {
    const { phase, card, task } = await completedPhase('With BA', [{ kind: 'regression' }]);
    const from = r.received.length;
    await dispatcher().run();
    const start = await baShift(from, 'phase_report');
    expect(start).toMatchObject({ kind: 'ba_task', worktree: null });
    expect(start.agent.name).toBe('Ben');
    expect(start.baTask).toMatchObject({
      taskId: task.id,
      kind: 'phase_report',
      phase: { ref: phase.ref, name: 'With BA', status: 'reporting', projectKey: 'TOY' },
    });
    expect(start.baTask.cards[0]).toMatchObject({ ref: card.ref, outcome: 'finalized', action: 'merge' });
    expect(start.baTask.followups[0]).toMatchObject({ kind: 'regression', status: 'pending' });
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['phase_report']);
    expect((await q('SELECT status, agent_id FROM ba_tasks WHERE id=$1', [task.id]))[0]?.status).toBe(
      'running',
    );

    // the BA cannot ask questions or use another task's outcome; a bad payload is refused
    expect(
      (await report(start.shiftId, { kind: 'question', text: 'which?', options: [], doing: 'x' })).error,
    ).toContain('no questions in a background task');
    expect(
      (await report(start.shiftId, { kind: 'outcome', outcomeId: 'phase_ready', note: 'x', data: {} }))
        .accepted,
    ).toBe(false);
    expect(
      (await report(start.shiftId, { kind: 'outcome', outcomeId: 'phase_report', note: 'x', data: {} }))
        .accepted,
    ).toBe(false);
    expect((await report(start.shiftId, { kind: 'comment', note: 'Reading the cards' })).accepted).toBe(true);

    const res = await report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'phase_report',
      note: 'report',
      data: { report: '# Done\nEverything shipped.', outstanding: ['Docs still to write'] },
    });
    expect(res.accepted).toBe(true);
    await endShift(start.shiftId);
    expect(await phaseStatus(phase.id)).toBe('awaiting_approval');
    const row = (
      await q('SELECT report, outstanding, report_desk_item_id FROM phases WHERE id=$1', [phase.id])
    )[0]!;
    expect(row.report).toBe('# Done\nEverything shipped.');
    expect(row.outstanding.map((o: any) => o.text)).toContain('Docs still to write');
    const item = (
      await q('SELECT asked_by_kind, asked_by_role, body FROM desk_items WHERE id=$1', [
        row.report_desk_item_id,
      ])
    )[0]!;
    expect(item).toMatchObject({ asked_by_kind: 'agent', asked_by_role: 'ba' });
    expect((await q('SELECT status FROM ba_tasks WHERE id=$1', [task.id]))[0]?.status).toBe('done');
    // the comment is on the phase thread
    expect(
      (
        await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND author_kind='agent'`, [phase.id])
      ).map((m) => m.body),
    ).toContain('Reading the cards');
    // a second report for the finished task is refused
    expect((await report(start.shiftId, { kind: 'comment', note: 'again' })).accepted).toBe(false);
  });

  it('approving queues a briefing task: follow-ups must all be briefed for the right delegate before phase_ready', async () => {
    const { phase } = await completedPhase('Briefed', [
      { kind: 'regression' },
      { kind: 'custom', instruction: 'Write notes' },
    ]);
    let from = r.received.length;
    await dispatcher().run();
    const rs = await baShift(from, 'phase_report');
    await report(rs.shiftId, {
      kind: 'outcome',
      outcomeId: 'phase_report',
      note: 'r',
      data: { report: 'ok' },
    });
    await endShift(rs.shiftId);
    const itemId = (await q('SELECT report_desk_item_id FROM phases WHERE id=$1', [phase.id]))[0]!
      .report_desk_item_id;

    from = r.received.length;
    await ok(owner('POST', `/api/desk/${itemId}/resolve`, { resolution: 'approved' }));
    expect(await phaseStatus(phase.id)).toBe('running_followups');
    await dispatcher().run();
    const start = await baShift(from, 'followups_brief');
    expect(start.baTask.followups.map((f: any) => [f.position, f.status])).toEqual([
      [1, 'queued'],
      [2, 'queued'],
    ]);
    const brief = async (position: number, to: string, text = 'do it') => {
      const rpcId = crypto.randomUUID();
      const f = r.received.length;
      r.send('rpc.request', {
        rpcId,
        shiftId: start.shiftId,
        method: 'phase.followup.brief',
        params: { position, to, text },
      });
      return (await r.waitFor('rpc.response', (x) => x.rpcId === rpcId, 5000, f)) as any;
    };
    const ready = () =>
      report(start.shiftId, { kind: 'outcome', outcomeId: 'phase_ready', note: 'x', data: {} });

    expect((await ready()).error).toContain('follow-up 1, 2');
    expect((await brief(1, 'devops')).error).toContain('goes to tester');
    expect((await brief(3, 'devops')).error).toContain('no follow-up 3');
    expect((await brief(1, 'tester', 'run the suite')).ok).toBe(true);
    expect((await ready()).error).toContain('follow-up 2');
    expect((await brief(2, 'ba', 'write the notes yourself')).ok).toBe(true);
    expect((await ready()).accepted).toBe(true);
    await endShift(start.shiftId);
    const rows = await q(
      'SELECT status, delegate, brief FROM phase_followups WHERE phase_id=$1 ORDER BY position',
      [phase.id],
    );
    expect(rows).toEqual([
      { status: 'briefed', delegate: 'tester', brief: 'run the suite' },
      { status: 'briefed', delegate: 'ba', brief: 'write the notes yourself' },
    ]);
    expect(
      (await q(`SELECT status FROM ba_tasks WHERE phase_id=$1 AND kind='followups_brief'`, [phase.id]))[0]
        ?.status,
    ).toBe('done');
  });
});

describe('one task at a time, failed attempts, lost shifts', () => {
  it('a BA takes one task shift at a time; the next starts when the first ended', async () => {
    const a = await completedPhase('Serial A');
    const b = await completedPhase('Serial B');
    const from = r.received.length;
    await dispatcher().run();
    const first = await baShift(from, 'phase_report');
    expect(first.baTask.phase.ref).toBe(a.phase.ref);
    // BA task shifts keep the single-vault shape: no `vaults` list
    expect(first.vaults).toBeUndefined();
    await dispatcher().run();
    await r.barrier();
    expect(
      r.received.slice(from).filter((f) => f.type === 'shift.start' && (f as any).kind === 'ba_task'),
    ).toHaveLength(1);
    await report(first.shiftId, {
      kind: 'outcome',
      outcomeId: 'phase_report',
      note: 'r',
      data: { report: 'A' },
    });
    await endShift(first.shiftId);
    await dispatcher().run();
    const second = (await r.waitFor(
      'shift.start',
      (f) => (f as any).baTask?.phase?.ref === b.phase.ref,
      5000,
      from,
    )) as any;
    r.accepted(second.shiftId);
    r.started(second.shiftId);
    await report(second.shiftId, {
      kind: 'outcome',
      outcomeId: 'phase_report',
      note: 'r',
      data: { report: 'B' },
    });
    await endShift(second.shiftId);
  });

  it('two shifts that end without a report make the server do the task', async () => {
    const { phase, task } = await completedPhase('Flaky BA');
    for (let i = 1; i <= 2; i++) {
      const from = r.received.length;
      await dispatcher().run();
      const start = await baShift(from, 'phase_report');
      await endShift(start.shiftId, 'no_report');
      const t = (await q('SELECT status, attempts FROM ba_tasks WHERE id=$1', [task.id]))[0]!;
      expect(t.attempts).toBe(i);
      expect(t.status).toBe(i === 1 ? 'queued' : 'queued');
    }
    await dispatcher().run();
    expect((await q('SELECT status FROM ba_tasks WHERE id=$1', [task.id]))[0]?.status).toBe('fallback');
    expect(await phaseStatus(phase.id)).toBe('awaiting_approval');
    expect((await q('SELECT report FROM phases WHERE id=$1', [phase.id]))[0]?.report).toContain('generated');
  });

  it('a rejected or lost shift goes back to the queue without counting as an attempt', async () => {
    const { task } = await completedPhase('Rejected BA');
    let from = r.received.length;
    await dispatcher().run();
    const first = (await r.waitFor(
      'shift.start',
      (f) => f.kind === 'ba_task' && (f as any).baTask?.taskId === task.id,
      5000,
      from,
    )) as any;
    r.rejected(first.shiftId, 'busy');
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [first.shiftId]))[0],
      3000,
      'ended',
    );
    expect((await q('SELECT status, attempts FROM ba_tasks WHERE id=$1', [task.id]))[0]).toMatchObject({
      status: 'queued',
      attempts: 0,
    });
    w.t.clock.advance(31_000); // the rejection cooldown of the agent
    from = r.received.length;
    await dispatcher().run();
    const second = (await r.waitFor(
      'shift.start',
      (f) => (f as any).baTask?.taskId === task.id,
      5000,
      from,
    )) as any;
    // the runner reconnects without the shift: lost, requeued, attempts unchanged
    r.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'offline');
    r = await w.connectRunner();
    await until(
      async () => (await q(`SELECT status FROM shifts WHERE id=$1`, [second.shiftId]))[0]?.status === 'ended',
      5000,
      'lost',
    );
    expect((await q('SELECT status, attempts FROM ba_tasks WHERE id=$1', [task.id]))[0]).toMatchObject({
      status: 'queued',
      attempts: 0,
    });
    // finish it so later tests start clean
    from = r.received.length;
    await dispatcher().run();
    const third = await baShift(from, 'phase_report');
    await report(third.shiftId, {
      kind: 'outcome',
      outcomeId: 'phase_report',
      note: 'r',
      data: { report: 'ok' },
    });
    await endShift(third.shiftId);
  });
});

describe('the preferred BA', () => {
  it('the intake BA of the phase gets its tasks', async () => {
    const second = await w.hire('Una', 'ba', 'senior');
    const ben = (await q(`SELECT id FROM agents WHERE name='Ben'`))[0]!.id;
    // Ben was busier more recently; without a preference Una (least recently busy) would be chosen
    await q(`UPDATE agents SET last_shift_ended_at = now() - interval '1 hour' WHERE id=$1`, [ben]);
    await q(`UPDATE agents SET last_shift_ended_at = now() WHERE id=$1`, [second.id]);
    const { phase, task } = await completedPhase('Preferred');
    await q('UPDATE ba_tasks SET preferred_agent_id=$2 WHERE id=$1', [task.id, ben]);
    const from = r.received.length;
    await dispatcher().run();
    const start = await baShift(from, 'phase_report');
    expect(start.agent.name).toBe('Ben');
    await report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'phase_report',
      note: 'r',
      data: { report: 'ok' },
    });
    await endShift(start.shiftId);
    expect(await phaseStatus(phase.id)).toBe('awaiting_approval');
  });
});

describe('a custom follow-up the BA carries out itself', () => {
  it('brief -> custom task -> done -> results report by the BA; a failure stops nothing after it only when it failed', async () => {
    const { phase } = await completedPhase('Custom by BA', [
      { kind: 'custom', instruction: 'Summarise the changes for the newsletter' },
      { kind: 'custom', instruction: 'Second thing' },
    ]);
    const send = async (start: any, method: string, params: Record<string, unknown>) => {
      const rpcId = crypto.randomUUID();
      const f = r.received.length;
      r.send('rpc.request', { rpcId, shiftId: start.shiftId, method, params });
      return (await r.waitFor('rpc.response', (x) => x.rpcId === rpcId, 5000, f)) as any;
    };
    // report
    let from = r.received.length;
    await dispatcher().run();
    const rs = await baShift(from, 'phase_report');
    await report(rs.shiftId, {
      kind: 'outcome',
      outcomeId: 'phase_report',
      note: 'r',
      data: { report: 'ok' },
    });
    await endShift(rs.shiftId);
    const itemId = (await q('SELECT report_desk_item_id FROM phases WHERE id=$1', [phase.id]))[0]!
      .report_desk_item_id;
    // approve and brief both to the BA
    from = r.received.length;
    await ok(owner('POST', `/api/desk/${itemId}/resolve`, { resolution: 'approved' }));
    await dispatcher().run();
    const bs = await baShift(from, 'followups_brief');
    expect(
      (await send(bs, 'phase.followup.brief', { position: 1, to: 'ba', text: 'do the summary' })).ok,
    ).toBe(true);
    expect(
      (await send(bs, 'phase.followup.brief', { position: 2, to: 'ba', text: 'do the second' })).ok,
    ).toBe(true);
    await report(bs.shiftId, { kind: 'outcome', outcomeId: 'phase_ready', note: 'x', data: {} });
    await endShift(bs.shiftId);
    // the server starts follow-up 1: a custom task for the BA
    from = r.received.length;
    await dispatcher().run();
    const cs = await baShift(from, 'followup_custom');
    expect(cs.baTask.followupId).toBeTruthy();
    expect(
      (await q('SELECT status FROM phase_followups WHERE phase_id=$1 ORDER BY position', [phase.id])).map(
        (f) => f.status,
      ),
    ).toEqual(['running', 'briefed']);
    // a wrong position is refused; the right one finishes the follow-up
    expect(
      (
        await report(cs.shiftId, {
          kind: 'outcome',
          outcomeId: 'followup_done',
          note: 'x',
          data: { position: 2, summary: 's' },
        })
      ).accepted,
    ).toBe(false);
    expect(
      (
        await report(cs.shiftId, {
          kind: 'outcome',
          outcomeId: 'followup_done',
          note: 'x',
          data: { position: 1, summary: 'wrote the summary', links: ['https://example.test/notes'] },
        })
      ).accepted,
    ).toBe(true);
    await endShift(cs.shiftId);
    // follow-up 2 fails: no BA online would fail it, here the BA reports failure
    from = r.received.length;
    await dispatcher().run();
    const c2 = await baShift(from, 'followup_custom');
    await report(c2.shiftId, {
      kind: 'outcome',
      outcomeId: 'followup_failed',
      note: 'x',
      data: { position: 2, summary: 'could not reach the newsletter tool' },
    });
    await endShift(c2.shiftId);
    const rows = await q(
      'SELECT status, result_summary, evidence FROM phase_followups WHERE phase_id=$1 ORDER BY position',
      [phase.id],
    );
    expect(rows.map((f) => f.status)).toEqual(['succeeded', 'failed']);
    expect(rows[0]?.evidence).toEqual({ links: ['https://example.test/notes'] });
    // the results task goes to the BA, who posts the report: pinned because one failed
    from = r.received.length;
    await dispatcher().run();
    expect(await phaseStatus(phase.id)).toBe('reporting_results');
    const fin = await baShift(from, 'followups_report');
    expect(fin.baTask.followups.map((f: any) => f.status)).toEqual(['succeeded', 'failed']);
    await report(fin.shiftId, {
      kind: 'outcome',
      outcomeId: 'phase_results',
      note: 'x',
      data: { report: 'One failed: the newsletter tool.' },
    });
    await endShift(fin.shiftId);
    const row = (
      await q('SELECT status, results_report, results_desk_item_id FROM phases WHERE id=$1', [phase.id])
    )[0]!;
    expect(row).toMatchObject({
      status: 'done_with_failures',
      results_report: 'One failed: the newsletter tool.',
    });
    expect(
      (await q('SELECT pinned, asked_by_kind FROM desk_items WHERE id=$1', [row.results_desk_item_id]))[0],
    ).toEqual({
      pinned: true,
      asked_by_kind: 'agent',
    });
  });

  it('with no BA online a custom follow-up for the BA fails with "no BA available"', async () => {
    const { phase } = await completedPhase('Custom no BA', [{ kind: 'custom', instruction: 'Needs the BA' }]);
    let from = r.received.length;
    await dispatcher().run();
    const rs = await baShift(from, 'phase_report');
    await report(rs.shiftId, {
      kind: 'outcome',
      outcomeId: 'phase_report',
      note: 'r',
      data: { report: 'ok' },
    });
    await endShift(rs.shiftId);
    const id = (await q('SELECT report_desk_item_id FROM phases WHERE id=$1', [phase.id]))[0]
      ?.report_desk_item_id;
    from = r.received.length;
    await ok(owner('POST', `/api/desk/${id}/resolve`, { resolution: 'approved' }));
    await dispatcher().run();
    const bs = await baShift(from, 'followups_brief');
    const rpcId = crypto.randomUUID();
    const f = r.received.length;
    r.send('rpc.request', {
      rpcId,
      shiftId: bs.shiftId,
      method: 'phase.followup.brief',
      params: { position: 1, to: 'ba', text: 'x' },
    });
    await r.waitFor('rpc.response', (x) => x.rpcId === rpcId, 5000, f);
    await report(bs.shiftId, { kind: 'outcome', outcomeId: 'phase_ready', note: 'x', data: {} });
    await endShift(bs.shiftId);
    // the BA agents are retired before the custom task is dispatched: the server fails the follow-up, nobody blocks
    await q(`UPDATE agents SET status='retired' WHERE role_key='ba'`);
    await dispatcher().run();
    await dispatcher().run();
    const rows = await q('SELECT status, result_summary FROM phase_followups WHERE phase_id=$1', [phase.id]);
    expect(rows[0]).toMatchObject({
      status: 'failed',
      result_summary: 'no BA was available to carry out this instruction',
    });
    await q(`UPDATE agents SET status='active' WHERE role_key='ba'`);
  });
});
