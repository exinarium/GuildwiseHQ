import { randomUUID } from 'node:crypto';
import { floorDigestIsEmpty, REPORT_DESK_SUBKIND, renderFloorReportFallback, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFloorDigest } from '../src/reporter/digest.ts';
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
const reporter = () => w.t.app.ctx.services.reporter;
const online = () =>
  q(`UPDATE workstations SET connected=true, last_seen_at=$2 WHERE id=$1`, [
    w.workstationId,
    w.t.clock.now(),
  ]);
/** Sets the test clock to an absolute instant. */
const setNow = async (iso: string) => {
  w.t.clock.setOffset(new Date(iso).getTime() - Date.now());
  // sessions expire against the (moved) clock: sign in again
  w.owner.cookie = await w.t.login(w.owner.email);
  await online();
};
const floorTasks = () => q(`SELECT * FROM ba_tasks WHERE kind='floor_report' ORDER BY created_at`);
const floorItems = () => q(`SELECT * FROM desk_items WHERE subkind='floor_report' ORDER BY created_at`);

async function clean() {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, thread_messages, desk_items,
       card_blockers, ledger_entries, ba_tasks, ba_signals, runner_commands, runner_inbox, phases CASCADE`,
  );
  await q(`UPDATE users SET floor_report_day=NULL WHERE id=$1`, [w.owner.id]);
  await online();
}

/** Something worth reporting: a card in rework round 3 raises a (normal) signal. */
async function somethingHappened() {
  const card = await w.card({ title: `Reworked ${randomUUID().slice(0, 4)}` });
  await q(`UPDATE cards SET rework_round = 3 WHERE id=$1`, [card.id]);
  return card;
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

describe('the daily floor report is at 08:00 on the manager clock', () => {
  it('Africa/Johannesburg: due at 06:00 UTC, once per local day, and only when something happened', async () => {
    await clean();
    await ok(owner('PUT', '/api/auth/timezone', { timezone: 'Africa/Johannesburg' }));
    await setNow('2026-11-10T05:00:00Z');
    await online();
    // quiet day: nothing to say, no report (and no task)
    await reporter().run();
    expect(await floorTasks()).toHaveLength(0);

    await somethingHappened();
    await setNow('2026-11-10T05:59:00Z'); // 07:59 in Johannesburg
    await online();
    await reporter().run();
    expect(await floorTasks()).toHaveLength(0);

    await setNow('2026-11-10T06:00:30Z'); // 08:00 in Johannesburg
    await online();
    await reporter().run();
    const [task] = await floorTasks();
    expect(task).toMatchObject({ status: 'queued', local_date: '2026-11-10' });
    expect(task!.signal_ids.length).toBeGreaterThanOrEqual(1);
    // the same local day: not again
    await reporter().run();
    expect(await floorTasks()).toHaveLength(1);

    // the next local day at 08:00 (06:00 UTC)
    await setNow('2026-11-11T05:59:00Z');
    await online();
    await reporter().run();
    expect(await floorTasks()).toHaveLength(1);
    await setNow('2026-11-11T06:01:00Z');
    await online();
    await reporter().run();
    expect((await floorTasks()).map((t) => t.local_date)).toEqual(['2026-11-10', '2026-11-11']);
  });

  it('the same instant is another day elsewhere: Los Angeles is not yet at 08:00', async () => {
    await clean();
    await ok(owner('PUT', '/api/auth/timezone', { timezone: 'America/Los_Angeles' }));
    await q(`UPDATE users SET floor_report_day='2026-11-09' WHERE id=$1`, [w.owner.id]); // yesterday's went out
    await somethingHappened();
    await setNow('2026-11-10T06:30:00Z'); // 22:30 the day before in Los Angeles
    await online();
    await reporter().run();
    expect(await floorTasks()).toHaveLength(0);
    await setNow('2026-11-10T15:59:00Z'); // 07:59 in Los Angeles (PST, UTC-8)
    await online();
    await reporter().run();
    expect(await floorTasks()).toHaveLength(0);
    await setNow('2026-11-10T16:01:00Z'); // 08:01
    await online();
    await reporter().run();
    expect((await floorTasks())[0]).toMatchObject({ local_date: '2026-11-10' });
  });

  it('dailyAt is a setting; with no time zone set the report runs on UTC', async () => {
    await clean();
    await q(`UPDATE users SET timezone=NULL WHERE id=$1`, [w.owner.id]);
    await ok(owner('PUT', '/api/reporting', { dailyAt: '09:30' }));
    await somethingHappened();
    await setNow('2026-11-12T09:29:00Z');
    await online();
    await reporter().run();
    expect(await floorTasks()).toHaveLength(0);
    await setNow('2026-11-12T09:31:00Z');
    await online();
    await reporter().run();
    expect(await floorTasks()).toHaveLength(1);
    await ok(owner('PUT', '/api/reporting', { dailyAt: '08:00' }));
    await ok(owner('PUT', '/api/auth/timezone', { timezone: 'Africa/Johannesburg' }));
  });
});

describe('the floor report content', () => {
  it('lists phases (and late bugs), stuck and backing-off cards, approvals, failures, open DevOps work and what the BA resolved', async () => {
    await clean();
    await setNow('2026-11-13T07:00:00Z');
    await online();
    // a phase held open by a late bug
    const phase = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Autosave' }),
      201,
    );
    await q(`UPDATE phases SET status='open', completed_at=$2 WHERE id=$1`, [
      phase.id,
      new Date(w.t.clock.now().getTime() - 3600_000),
    ]);
    const bug = await w.card({ title: 'Autosave drops text' });
    await q(`UPDATE cards SET origin='test_failure', phase_id=$2, phase_assignment='confirmed' WHERE id=$1`, [
      bug.id,
      phase.id,
    ]);
    // a card backing off after failed shifts
    const looping = await w.card({ title: 'Looping builder' });
    await q(`UPDATE cards SET retry_after=$2, retry_failures=4, retry_episode_id=$3 WHERE id=$1`, [
      looping.id,
      new Date(w.t.clock.now().getTime() + 600_000),
      randomUUID(),
    ]);
    // failed shifts in the window
    const ben = await w.hire('Una', 'builder', 'junior');
    for (let i = 0; i < 2; i++)
      await q(
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, outcome, runtime, model, overflow, started_at, ended_at)
         VALUES ($1,$2,$3,$4,$5,'card','build','ended','no_report','mock','mock',false,$6,$6)`,
        [randomUUID(), w.owner.id, ben.id, w.workstationId, looping.id, w.t.clock.now()],
      );
    // an open DevOps request
    const devops = (await q(`SELECT id FROM agents WHERE is_devops AND org_id=$1`, [w.owner.id]))[0]!;
    await q(
      `INSERT INTO devops_requests (id, org_id, workstation_id, devops_agent_id, thread_id, requested_by_kind, summary, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'system','Deploy staging','needs_approval',$6,$6)`,
      [randomUUID(), w.owner.id, w.workstationId, devops.id, randomUUID(), w.t.clock.now()],
    );
    // what the BA resolved: a dismissed held alert
    const alertId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.desk(alertId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: alertId,
            kind: 'alert',
            subkind: 'bug_reported',
            title: 'Noise',
            projectId: w.projectId,
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await seed(w, [
      {
        streamId: streamId.desk(alertId),
        event: {
          type: 'DeskItemTriaged',
          payload: {
            deskItemId: alertId,
            outcome: 'dismissed',
            note: 'duplicate of the board',
            by: { kind: 'system' },
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await somethingHappened();
    await reporter().run();

    const d = await buildFloorDigest(w.t.app.ctx.pool, w.owner.id, w.t.clock.now(), '2026-11-13');
    expect(floorDigestIsEmpty(d)).toBe(false);
    expect(d.phases).toEqual([
      expect.objectContaining({ ref: phase.ref, status: 'open', lateBugs: [bug.ref] }),
    ]);
    expect(d.backingOff).toEqual([expect.objectContaining({ ref: looping.ref, failures: 4 })]);
    expect(d.failures).toEqual([expect.objectContaining({ ref: looping.ref, failedShifts: 2 })]);
    expect(d.devopsOpen).toEqual([
      expect.objectContaining({ summary: 'Deploy staging', status: 'needs_approval' }),
    ]);
    expect(d.resolvedByBa).toEqual([
      expect.objectContaining({ id: alertId, how: 'dismissed', note: 'duplicate of the board' }),
    ]);
    expect(d.signals.map((s) => s.kind)).toContain('rework');

    const text = renderFloorReportFallback(d);
    for (const h of [
      '## Phases',
      '## Stuck, blocked and backing-off cards',
      '## Repeated approvals',
      '## Failures',
      '## DevOps requests that are open',
      '## Resolved by the BA without bothering you',
    ])
      expect(text).toContain(h);
    expect(text).toContain(`held open by late bugs ${bug.ref}`);
    expect(text).toContain('Deploy staging on');
  });
});

describe('no BA: the server posts the floor report itself', () => {
  it('a template report with the same sections and no chat link', async () => {
    await clean();
    await q(`DELETE FROM agents WHERE role_key='ba'`);
    await ok(owner('PUT', '/api/auth/timezone', { timezone: 'Africa/Johannesburg' }));
    await somethingHappened();
    await setNow('2026-11-14T06:05:00Z');
    await online();
    await reporter().run();
    await dispatcher().run(); // no BA is hired: done at once
    const [task] = await floorTasks();
    expect(task!.status).toBe('fallback');
    const [item] = await floorItems();
    expect(item).toMatchObject({
      kind: 'alert',
      asked_by_kind: 'system',
      title: 'Floor report 2026-11-14',
      project_id: null,
    });
    expect(item!.body).toContain('wrote this report from a template');
    expect(item!.body).toContain('## Failures');
    expect(item!.chat_thread_id).toBeNull();
    expect(item!.data.localDate).toBe('2026-11-14');
    // the signal in it is reported
    expect((await q(`SELECT status FROM ba_signals`))[0]?.status).toBe('reported');
    // and the manager sees it on the desk with the structured digest
    const desk = await ok<any>(owner('GET', '/api/desk'));
    const shown = desk.items.find((i: any) => i.id === item!.id);
    expect(shown.subkind).toBe(REPORT_DESK_SUBKIND.floorReport);
    expect(shown.floor.localDate).toBe('2026-11-14');
    expect(shown.chatThreadId).toBeNull();
  });
});

describe('the BA writes the report and a standing chat holds the discussion', () => {
  it('the report is a desk item that links to one chat thread per org, reused by the next report', async () => {
    await clean();
    const ben = await w.hire('Ben', 'ba', 'senior');
    await ok(owner('PUT', '/api/auth/timezone', { timezone: 'Africa/Johannesburg' }));
    await somethingHappened();
    await setNow('2026-11-15T06:05:00Z');
    await online();
    await reporter().run();
    const from = r.received.length;
    await dispatcher().run();
    const start = await baShift(from, 'floor_report');
    expect(start.baTask.reporter.digest.localDate).toBe('2026-11-15');
    expect(start.baTask.reporter.digest.signals.map((s: any) => s.kind)).toContain('rework');
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['floor_report']);
    expect((await baReport(start.shiftId, 'floor_report', { report: '' })).accepted).toBe(false);
    const res = await baReport(start.shiftId, 'floor_report', {
      report: '# Floor report\n\nOne card is in rework round 3: look at it today.',
    });
    expect(res.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');

    const [item] = await floorItems();
    expect(item).toMatchObject({ asked_by_kind: 'agent', asked_by_role: 'ba' });
    expect(item!.body).toContain('rework round 3');
    const thread = (await q(`SELECT * FROM threads WHERE id=$1`, [item!.chat_thread_id]))[0]!;
    expect(thread).toMatchObject({
      kind: 'chat',
      agent_id: ben.id,
      title: 'BA reports',
      created_by: w.owner.id,
    });
    expect(
      (await q(`SELECT ba_chat_thread_id FROM users WHERE id=$1`, [w.owner.id]))[0]?.ba_chat_thread_id,
    ).toBe(thread.id);
    // the manager sees the link and can open the chat
    const desk = await ok<any>(owner('GET', '/api/desk'));
    expect(desk.items.find((i: any) => i.id === item!.id).chatThreadId).toBe(thread.id);
    await ok(owner('GET', `/api/chats/${thread.id}`));

    // tomorrow's report reuses the thread
    await setNow('2026-11-16T06:05:00Z');
    await online();
    await reporter().run();
    const from2 = r.received.length;
    await dispatcher().run();
    const start2 = await baShift(from2, 'floor_report');
    await baReport(start2.shiftId, 'floor_report', { report: 'Day two.' });
    r.ended(start2.shiftId, 'reported');
    const items = await floorItems();
    expect(items).toHaveLength(2);
    expect(items[1]!.chat_thread_id).toBe(thread.id);
    expect(await q(`SELECT 1 FROM threads WHERE title='BA reports'`)).toHaveLength(1);
  });

  it('an urgent signal is reported at any hour: the BA analyses it and the analysis is a note on the loop alert', async () => {
    await clean();
    await setNow('2026-11-17T01:00:00Z'); // 03:00 in Johannesburg: no quiet hours for urgent notices
    await online();
    const card = await w.card({ title: 'Burning tokens' });
    const alertId = randomUUID();
    await seed(w, [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardRetryDeferred',
          payload: {
            cardId: card.id,
            until: new Date(w.t.clock.now().getTime() + 60_000).toISOString(),
            failures: 3,
            episodeId: randomUUID(),
            newEpisode: true,
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
      {
        streamId: streamId.desk(alertId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: alertId,
            kind: 'alert',
            subkind: 'loop_backoff',
            title: `${card.ref} keeps failing`,
            cardId: card.id,
            projectId: w.projectId,
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM,
        scope: scope(),
      },
    ]);
    await reporter().run();
    const [task] = await q(`SELECT * FROM ba_tasks WHERE kind='floor_alert'`);
    expect(task!.signal_ids).toHaveLength(1);
    const from = r.received.length;
    await dispatcher().run();
    const start = await baShift(from, 'floor_alert');
    expect(start.baTask.reporter.signals[0]).toMatchObject({ kind: 'loop', urgency: 'urgent' });
    const res = await baReport(start.shiftId, 'signal_report', {
      reports: [
        {
          signalId: task!.signal_ids[0],
          summary: 'The tester sandbox denies `npm test`. Allow it or stop the card.',
          annotateItemId: alertId,
        },
      ],
    });
    expect(res.accepted).toBe(true);
    const desk = await ok<any>(owner('GET', '/api/desk'));
    expect(desk.items.find((i: any) => i.id === alertId).baNote).toContain('denies `npm test`');
    expect((await q(`SELECT status FROM ba_signals`))[0]?.status).toBe('reported');
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='ba_report'`)).toHaveLength(0);
  });

  it('an urgent signal without an alert of its own becomes an alert/ba_report with the chat link', async () => {
    await clean();
    online();
    const asked: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      asked.push(id);
      await seed(w, [
        {
          streamId: streamId.desk(id),
          event: {
            type: 'DeskItemCreated',
            payload: {
              deskItemId: id,
              kind: 'approval',
              subkind: 'devops',
              title: 'DevOps needs approval: docker compose up',
              blocking: true,
              pinned: true,
              projectId: w.projectId,
            },
          },
          actor: SYSTEM,
          scope: scope(),
        },
      ]);
    }
    await q(`UPDATE desk_items SET status='answered', answer_option='rejected' WHERE id=$1`, [asked[0]]);
    await online();
    await reporter().run();
    const [task] = await q(`SELECT * FROM ba_tasks WHERE kind='floor_alert'`);
    const from = r.received.length;
    await dispatcher().run();
    const start = await baShift(from, 'floor_alert');
    const res = await baReport(start.shiftId, 'signal_report', {
      reports: [
        {
          signalId: task!.signal_ids[0],
          summary: 'Asked 3 times and rejected once. Grant allowDocker or stop asking.',
        },
      ],
    });
    expect(res.accepted).toBe(true);
    const item = (await q(`SELECT * FROM desk_items WHERE subkind='ba_report'`))[0]!;
    expect(item).toMatchObject({ kind: 'alert', asked_by_role: 'ba', status: 'open' });
    expect(item.body).toContain('allowDocker');
    expect(item.chat_thread_id).not.toBeNull();
    r.ended(start.shiftId, 'reported');
  });
});
