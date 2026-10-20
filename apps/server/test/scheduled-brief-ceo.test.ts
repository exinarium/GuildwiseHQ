import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appoint, keepOnline, startCeoShift } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * docs/design/ceo-front-door.md step 3: a schedule's `ba_task` action (the name stays so old schedules keep working) is a
 * `scheduled_brief` wake of the CEO. No BA task is queued; the CEO's brief carries the instructions, and when the CEO cannot
 * run for two hours the owner is told the task was skipped.
 */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await w.hire('Ben', 'ba', 'senior');
  await appoint(w);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const dispatcher = () => w.t.app.ctx.services.dispatcher;

async function scheduled(name: string, prompt: string) {
  const s = await ok<any>(
    owner('POST', '/api/schedules', {
      name,
      trigger: { kind: 'manual' },
      action: { kind: 'ba_task', projectId: null, prompt, deliver: 'desk_notice' },
    }),
    201,
  );
  await ok(owner('POST', `/api/schedules/${s.id}/run`), 201);
  return s;
}
const wakeOf = async (scheduleId: string) =>
  (
    await q(`SELECT * FROM ceo_wakes WHERE reason='scheduled_brief' AND detail->>'scheduleId'=$1`, [
      scheduleId,
    ])
  )[0];

describe('a scheduled task is a CEO wake', () => {
  it('queues a wake with the instructions, no BA task; the brief carries them and the way to deliver the answer', async () => {
    await keepOnline(w);
    const s = await scheduled('Friday review', 'List the open phases for the Owner');
    expect(await q(`SELECT 1 FROM ba_tasks WHERE schedule_id=$1`, [s.id])).toHaveLength(0);
    const wake = await wakeOf(s.id);
    expect(wake).toMatchObject({ urgency: 'scheduled', status: 'pending', subject_label: 'Friday review' });
    expect(wake?.detail).toMatchObject({
      scheduleName: 'Friday review',
      instructions: 'List the open phases for the Owner',
      deliver: 'desk_notice',
    });

    const start = await startCeoShift(w, r, r.received.length);
    expect(start.ceo.reasons.map((x: any) => x.reason)).toContain('scheduled_brief');
    expect(start.ceo.brief).toContain('Scheduled tasks from the owner');
    expect(start.ceo.brief).toContain('### Friday review');
    expect(start.ceo.brief).toContain('List the open phases for the Owner');
    expect(start.ceo.brief).toContain('aom ceo notify --kind task_done');
    const { reportId } = r.report(start.shiftId, {
      kind: 'outcome',
      outcomeId: 'ceo_done',
      note: 'done',
      data: { summary: 'listed' },
    });
    await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
    r.ended(start.shiftId, 'reported');
    await r.barrier();
    expect((await wakeOf(s.id))?.status).toBe('done');
  });

  it('a CEO that cannot run for two hours: the owner gets a notice that the task was skipped, and the wake is closed', async () => {
    await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE kind='ceo' AND status <> 'ended'`);
    const s = await scheduled('Monthly summary', 'Summarise the month');
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    await dispatcher().run();
    expect((await wakeOf(s.id))?.status).toBe('pending');
    w.t.clock.advance(121 * 60_000);
    await dispatcher().run();
    expect((await wakeOf(s.id))?.status).toBe('done');
    const notice = (
      await q(`SELECT * FROM desk_items WHERE subkind='ceo_notice' AND title LIKE 'Monthly summary%'`)
    )[0];
    expect(notice?.title).toBe('Monthly summary was not carried out');
    expect(notice?.body).toContain('Summarise the month');
    expect(await q(`SELECT 1 FROM ba_tasks WHERE schedule_id=$1`, [s.id])).toHaveLength(0);
    await keepOnline(w);
  });
});
