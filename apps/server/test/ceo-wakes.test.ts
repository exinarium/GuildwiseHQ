import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, appoint, graduate, keepOnline, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let agentId: string;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  agentId = await appoint(w);
  await graduate(w);
  await ok(w.t.req('PUT', '/api/reporting', { cookie: w.owner.cookie, body: { routeViaBa: true } }));
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const reporter = () => w.t.app.ctx.services.reporter;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const wakes = (status?: string) =>
  q(`SELECT * FROM ceo_wakes ${status ? `WHERE status='${status}'` : ''} ORDER BY created_at`);
const shifts = () => q(`SELECT * FROM shifts WHERE kind='ceo' ORDER BY started_at`);

async function clean() {
  await q(`TRUNCATE ceo_wakes, ceo_batches, ceo_flags`);
  await q(`DELETE FROM desk_items WHERE subkind IN ('ceo_notice','ceo_report','bug_reported')`);
  await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE kind='ceo' AND status <> 'ended'`);
  await keepOnline(w);
}

/** Finishes the running CEO shift the way the runner does: terminal report, then `shift.ended`. */
async function finish(
  shiftId: string,
  outcomeId = 'ceo_done',
  data: Record<string, unknown> = { summary: 'handled' },
) {
  const { reportId } = r.report(shiftId, { kind: 'outcome', outcomeId, note: outcomeId, data });
  const res = (await r.waitFor('shift.report.result', (f) => f.reportId === reportId)) as any;
  r.ended(shiftId, 'reported');
  await r.barrier();
  return res;
}

describe('batching and caps', () => {
  it('a normal wake waits for the debounce window, an urgent one starts at once', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'normal');
    await dispatcher().run();
    await r.barrier();
    expect(await shifts()).toHaveLength(0);
    w.t.clock.advance(6 * 60_000);
    await keepOnline(w);
    const from = r.received.length;
    const start = await startCeoShift(w, r, from);
    expect(start.ceo.wakeIds).toHaveLength(1);
    await finish(start.shiftId);
    expect((await wakes('done')).length).toBe(1);

    await wakeNow(w, 'desk_item', 'urgent');
    const from2 = r.received.length;
    const second = await startCeoShift(w, r, from2);
    expect(second.ceo.reasons[0].urgency).toBe('urgent');
    await finish(second.shiftId);
  });

  it('absorbs every pending wake into one shift, and runs only one at a time', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'normal');
    await wakeNow(w, 'signal:loop', 'urgent');
    await wakeNow(w, 'desk_item', 'normal');
    const from = r.received.length;
    const start = await startCeoShift(w, r, from);
    expect(start.ceo.wakeIds).toHaveLength(3);
    await wakeNow(w, 'signal:blocked', 'urgent'); // arrives during the shift
    await dispatcher().run();
    await r.barrier();
    expect(
      r
        .of('shift.start')
        .filter((f: any) => f.kind === 'ceo' && f.shiftId !== start.shiftId && r.received.indexOf(f) >= from),
    ).toHaveLength(0);
    expect((await wakes('pending')).length).toBe(1);
    await finish(start.shiftId);
    const next = await startCeoShift(w, r, r.received.length);
    expect(next.shiftId).not.toBe(start.shiftId);
    await finish(next.shiftId);
  });

  it('at most maxWakesPerHour shifts an hour: the rest wait', async () => {
    await clean();
    const pol = (await ok<any>(owner('GET', '/api/ceo/policy'))).policy;
    pol.limits.maxWakesPerHour = 2;
    await ok(owner('PUT', '/api/ceo/policy', { policy: pol }));
    for (let i = 0; i < 2; i++) {
      await wakeNow(w);
      const s = await startCeoShift(w, r, r.received.length);
      await finish(s.shiftId);
    }
    await wakeNow(w);
    const before = r.received.length;
    await dispatcher().run();
    await r.barrier();
    expect(r.received.slice(before).filter((f: any) => f.type === 'shift.start')).toHaveLength(0);
    expect((await wakes('pending')).length).toBe(1);
    w.t.clock.advance(61 * 60_000);
    const s = await startCeoShift(w, r, before);
    await finish(s.shiftId);
    pol.limits.maxWakesPerHour = 12;
    await ok(owner('PUT', '/api/ceo/policy', { policy: pol }));
  });

  it('a shift that ends without its report puts the wakes back; two failures drop the plain wake', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'urgent');
    const s1 = await startCeoShift(w, r, r.received.length);
    r.ended(s1.shiftId, 'crashed');
    await r.barrier();
    expect((await wakes('pending')).length).toBe(1);
    const s2 = await startCeoShift(w, r, r.received.length);
    r.ended(s2.shiftId, 'timeout');
    await r.barrier();
    expect((await wakes('failed')).length).toBe(1);
    expect((await wakes('pending')).length).toBe(0);
  });
});

describe('wake sources', () => {
  it('an agent question that reaches the desk wakes the CEO, marked as outside text', async () => {
    await clean();
    const id = randomUUID();
    await seed(w, [
      {
        streamId: streamId.desk(id),
        event: {
          type: 'QuestionRaised',
          payload: {
            deskItemId: id,
            projectId: w.projectId,
            askedBy: { kind: 'system' },
            question: 'Tabs or spaces?',
            options: [],
            blocking: false,
            routedTo: 'manager',
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
      },
    ]);
    await until(async () => (await wakes('pending')).length === 1, 3000, 'wake');
    expect((await wakes('pending'))[0]).toMatchObject({
      reason: 'question',
      untrusted: true,
      subject_id: id,
    });
  });

  it('what the CEO itself caused does not wake it', async () => {
    await clean();
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
            title: 'by the CEO',
            projectId: w.projectId,
            askedBy: { kind: 'agent', agentId, role: 'ceo' },
          },
        },
        actor: { kind: 'agent', id: agentId },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
      },
    ]);
    await r.barrier();
    await new Promise((x) => setTimeout(x, 200));
    expect(await wakes()).toHaveLength(0);
  });

  it('a subject the CEO just acted on is not woken again for a normal reason', async () => {
    await clean();
    const card = await w.card({ title: 'Cooldown' });
    await wakeNow(w, 'desk_item', 'urgent');
    const s = await startCeoShift(w, r, r.received.length);
    const res = (await act(r, s.shiftId, 'priority', { card: card.ref, to: 2 })) as any;
    expect(res.result.status).toBe('executed');
    await finish(s.shiftId);
    const { enqueueWake } = await import('../src/ceo/wakes.ts');
    const queued = await enqueueWake(
      w.t.app.ctx.pool,
      w.owner.id,
      { reason: 'x', urgency: 'normal', subjectKind: 'card', subjectId: card.id },
      w.t.clock.now(),
    );
    expect(queued).toBe(false);
    const urgent = await enqueueWake(
      w.t.app.ctx.pool,
      w.owner.id,
      { reason: 'x', urgency: 'urgent', subjectKind: 'card', subjectId: card.id },
      w.t.clock.now(),
    );
    expect(urgent).toBe(true);
  });
});

describe('routing: the CEO replaces the BA reporter', () => {
  const alert = async (title: string) => {
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
            body: 'b',
            projectId: w.projectId,
            askedBy: { kind: 'system' },
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
      },
    ]);
    return id;
  };

  it('with a reachable CEO a plain alert is held for it, no BA task is queued, and it never blocks', async () => {
    await clean();
    await w.hire('Ben', 'ba', 'senior');
    await keepOnline(w);
    const id = await alert('held for the CEO');
    const item = (await q(`SELECT triage, triage_deadline FROM desk_items WHERE id=$1`, [id]))[0]!;
    expect(item.triage).toBe('pending');
    expect(await q(`SELECT 1 FROM ba_tasks WHERE kind='desk_triage'`)).toHaveLength(0);
    await until(async () => (await wakes('pending')).length === 1, 3000, 'wake');
    // nobody looks at it: the reporter sweep releases it unchanged after the window
    w.t.clock.advance(11 * 60_000);
    await keepOnline(w);
    await reporter().run();
    expect((await q(`SELECT triage FROM desk_items WHERE id=$1`, [id]))[0]!.triage).toBe('released');
  });

  it('the CEO triages a held item (dismisses a plain alert)', async () => {
    await clean();
    const id = await alert('noise');
    await until(async () => (await wakes('pending')).length === 1, 3000, 'wake');
    w.t.clock.advance(6 * 60_000);
    const s = await startCeoShift(w, r, r.received.length);
    const res = (await act(r, s.shiftId, 'triage', {
      item: id,
      do: 'dismiss',
      note: 'duplicate of known noise',
    })) as any;
    expect(res.result.status).toBe('executed');
    expect((await q(`SELECT triage, status FROM desk_items WHERE id=$1`, [id]))[0]).toMatchObject({
      triage: 'dismissed',
    });
    await finish(s.shiftId);
  });

  it('with the CEO unreachable the item reaches the desk unchanged and the BA path is untouched', async () => {
    await clean();
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    const id = await alert('direct');
    expect((await q(`SELECT triage FROM desk_items WHERE id=$1`, [id]))[0]!.triage).toBe('none');
    await keepOnline(w);
  });

  it('a paused CEO hands the job back to the BA, and the owner can resume it', async () => {
    await clean();
    await ok(owner('POST', '/api/ceo/pause', {}));
    await keepOnline(w);
    const id = await alert('for the BA');
    expect((await q(`SELECT triage FROM desk_items WHERE id=$1`, [id]))[0]!.triage).toBe('pending');
    expect((await q(`SELECT 1 FROM ba_tasks WHERE kind='desk_triage'`)).length).toBe(1);
    await ok(owner('POST', '/api/ceo/resume', {}));
  });
});

describe('the daily review', () => {
  const setNow = async (iso: string) => {
    w.t.clock.setOffset(new Date(iso).getTime() - Date.now());
    w.owner.cookie = await w.t.login(w.owner.email);
    await keepOnline(w);
  };
  const reviews = () => q(`SELECT * FROM ceo_wakes WHERE reason='daily_review' ORDER BY created_at`);
  const somethingHappened = async () => {
    const card = await w.card({ title: `Reworked ${randomUUID().slice(0, 4)}` });
    await q(`UPDATE cards SET rework_round = 3 WHERE id=$1`, [card.id]);
  };

  it('is queued once per local day at the report time, replaces the floor report, and is written by the CEO', async () => {
    await clean();
    await q(`UPDATE ceo_settings SET report_day=NULL`);
    await q(`TRUNCATE ba_tasks, ba_signals CASCADE`);
    await setNow('2026-12-01T05:00:00Z');
    await somethingHappened();
    await reporter().run();
    expect(await reviews()).toHaveLength(0); // before 08:00
    await setNow('2026-12-01T08:01:00Z');
    await reporter().run();
    await reporter().run();
    expect(await reviews()).toHaveLength(1);
    expect(await q(`SELECT 1 FROM ba_tasks WHERE kind='floor_report'`)).toHaveLength(0);

    const start = await startCeoShift(w, r, r.received.length);
    expect(start.ceo.purpose).toBe('review');
    expect(start.brief.shift.outcomes.map((o: any) => o.id)).toEqual(['ceo_report']);
    expect(start.ceo.brief).toContain('Feedback');
    const badId = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'ceo_report',
      note: 'r',
      data: { report: '' },
    }).reportId;
    const bad = (await r.waitFor('shift.report.result', (f) => f.reportId === badId)) as any;
    expect(bad.accepted).toBe(false);
    const { reportId } = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'ceo_report',
      note: 'r',
      data: { report: '## Needs you\nnone\n\n## Decisions I took\nnone' },
    });
    const res = (await r.waitFor('shift.report.result', (f) => f.reportId === reportId)) as any;
    expect(res.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    const items = await q(`SELECT * FROM desk_items WHERE subkind='ceo_report'`);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('Daily report 2026-12-01');
    expect(items[0]!.body).toContain('The facts behind this report');
    expect(items[0]!.chat_thread_id).not.toBeNull();
    expect((await q(`SELECT report_day FROM ceo_settings`))[0]!.report_day).toBe('2026-12-01');
    await reporter().run();
    expect(await reviews()).toHaveLength(1); // not again the same day
  });

  it('when the CEO is unreachable for two hours the server posts a template report marked as such', async () => {
    await clean();
    await q(`UPDATE ceo_settings SET report_day=NULL`);
    await setNow('2026-12-02T08:05:00Z');
    await somethingHappened();
    await reporter().run();
    expect(await reviews()).toHaveLength(1);
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    w.t.clock.advance(31 * 60_000);
    await dispatcher().run();
    w.t.clock.advance(100 * 60_000);
    await dispatcher().run();
    const items = await q(`SELECT * FROM desk_items WHERE subkind='ceo_report' AND title LIKE '%2026-12-02'`);
    expect(items).toHaveLength(1);
    expect(items[0]!.body).toContain('your CEO was not available');
    expect(items[0]!.data.fallback).toBe(true);
    await keepOnline(w);
  });

  it('an urgent wake waiting for an offline CEO raises one notice after 30 minutes', async () => {
    await clean();
    await setNow('2026-12-03T10:00:00Z');
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    await wakeNow(w, 'signal:loop', 'urgent');
    await dispatcher().run();
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='ceo_notice'`)).toHaveLength(0);
    w.t.clock.advance(31 * 60_000);
    await dispatcher().run();
    await dispatcher().run();
    const n = await q(`SELECT * FROM desk_items WHERE subkind='ceo_notice'`);
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toContain('offline');
    await keepOnline(w);
  });
});
