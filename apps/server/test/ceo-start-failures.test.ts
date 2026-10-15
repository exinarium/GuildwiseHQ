import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_BRIEF_CHARS, MAX_LISTED_WAKES } from '../src/ceo/brief.ts';
import { enqueueWake } from '../src/ceo/wakes.ts';
import { appoint, graduate, keepOnline, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// Backlog #79: the CEO's shifts were rejected by the runner (workstation full: "busy"), nothing recorded why, the
// dispatcher tried again every second until its hourly cap, and a backlog of 148 wakes was one huge brief.

let w: World;
let r: FakeRunner;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await appoint(w);
  await graduate(w);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const batches = () => q(`SELECT * FROM ceo_batches ORDER BY created_at`);
const wakes = (status: string) => q(`SELECT * FROM ceo_wakes WHERE status=$1`, [status]);
const notices = () =>
  q(`SELECT * FROM desk_items WHERE subkind='ceo_notice' AND title LIKE 'Your CEO cannot start%'`);

async function clean() {
  await q(`TRUNCATE ceo_wakes, ceo_batches, ceo_flags`);
  await q(`DELETE FROM desk_items WHERE subkind IN ('ceo_notice','ceo_report')`);
  await q(`UPDATE shifts SET status='ended', ended_at=now() WHERE kind='ceo' AND status <> 'ended'`);
  await keepOnline(w);
}

/** The next CEO `shift.start`, rejected the way a full runner does. */
async function rejectNext(reason: string, detail?: string) {
  await keepOnline(w);
  await r.barrier();
  const from = r.received.length;
  await dispatcher().run();
  const start = (await r.waitFor('shift.start', (f) => f.kind === 'ceo', 8000, from)) as any;
  r.rejected(start.shiftId, reason, detail ? { detail } : {});
  await r.barrier();
  await until(
    async () => (await q(`SELECT 1 FROM shifts WHERE id=$1 AND status='ended'`, [start.shiftId]))[0],
    3000,
  );
  return start;
}

describe('a rejected CEO shift', () => {
  it('records why on the batch, puts the wakes back and backs the dispatcher off', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'urgent');
    await rejectNext('busy', '4 shifts already running (limit 4)');
    const [b] = await batches();
    expect(b).toMatchObject({
      status: 'failed',
      outcome: 'rejected',
      error: 'busy: 4 shifts already running (limit 4)',
    });
    expect(await wakes('pending')).toHaveLength(1);

    // not again at once: the dispatcher waits a minute after the first failure
    const before = r.received.length;
    await dispatcher().run();
    await r.barrier();
    expect(r.received.slice(before).filter((f: any) => f.type === 'shift.start')).toHaveLength(0);
    w.t.clock.advance(61_000);
    await keepOnline(w);
    const s = await startCeoShift(w, r, before);
    r.ended(s.shiftId, 'reported');
    await r.barrier();
  });

  it('is not counted against maxWakesPerHour (the runner never ran it)', async () => {
    await clean();
    const pol = (await ok<any>(owner('GET', '/api/ceo/policy'))).policy;
    pol.limits.maxWakesPerHour = 1;
    await ok(owner('PUT', '/api/ceo/policy', { policy: pol }));
    await wakeNow(w, 'desk_item', 'urgent');
    await rejectNext('busy', 'x');
    w.t.clock.advance(61_000);
    await keepOnline(w);
    const s = await startCeoShift(w, r, r.received.length); // would be refused by the cap if the rejection counted
    r.ended(s.shiftId, 'reported');
    await r.barrier();
    pol.limits.maxWakesPerHour = 12;
    await ok(owner('PUT', '/api/ceo/policy', { policy: pol }));
  });

  it('after three failures in a row one desk notice says why; the Overview shows the last error; success clears both', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'urgent');
    for (let i = 0; i < 3; i++) {
      await rejectNext('busy', '4 shifts already running (limit 4)');
      if (i < 2) w.t.clock.advance(31 * 60_000);
    }
    await dispatcher().run(); // the pass that sees the third failure raises the notice (and still waits)
    await r.barrier();
    const first = await notices();
    expect(first).toHaveLength(1);
    expect(first[0]!.title).toBe('Your CEO cannot start: busy: 4 shifts already running (limit 4)');
    const status = await ok<any>(owner('GET', '/api/ceo/status'));
    expect(status.lastError).toMatchObject({
      outcome: 'rejected',
      message: 'busy: 4 shifts already running (limit 4)',
    });
    expect(status.lastError.failures).toBeGreaterThanOrEqual(3);

    // a fourth failure does not raise a second notice
    w.t.clock.advance(31 * 60_000);
    await rejectNext('busy', '4 shifts already running (limit 4)');
    await dispatcher().run();
    await r.barrier();
    expect(await notices()).toHaveLength(1);
    w.t.clock.advance(31 * 60_000);

    // the CEO runs: the error and the flag are gone, so a later episode is told again
    const from = r.received.length;
    const s = await startCeoShift(w, r, from);
    await dispatcher().run();
    expect((await ok<any>(owner('GET', '/api/ceo/status'))).lastError).toBeNull();
    expect(await q(`SELECT 1 FROM ceo_flags WHERE flag='start_failed'`)).toHaveLength(0);
    r.ended(s.shiftId, 'reported');
    await r.barrier();
  });

  it('a shift the runner never accepts (30 s) is rejected with that reason', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'urgent');
    await keepOnline(w);
    await r.barrier();
    const from = r.received.length;
    await dispatcher().run();
    await r.waitFor('shift.start', (f) => f.kind === 'ceo', 8000, from);
    w.t.clock.advance(31_000);
    await w.t.app.ctx.services.reaper.run();
    const [b] = await batches();
    expect(b).toMatchObject({
      status: 'failed',
      outcome: 'rejected',
      error: 'the runner did not accept the shift within 30 seconds',
    });
    expect(await wakes('pending')).toHaveLength(1);
  });

  it('a batch whose shift row is gone does not block the next wakes', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'urgent');
    const wake = (await wakes('pending'))[0]!;
    const ceoAgent = (await q(`SELECT id FROM agents WHERE role_key='ceo'`))[0]!.id;
    const batchId = randomUUID();
    await q(
      `INSERT INTO ceo_batches (id, org_id, agent_id, shift_id, purpose, status, attempts, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'wake','running',0,now(),now())`,
      [batchId, w.owner.id, ceoAgent, randomUUID()],
    );
    await q(`UPDATE ceo_wakes SET status='taken', batch_id=$2 WHERE id=$1`, [wake.id, batchId]);
    const s = await startCeoShift(w, r, r.received.length);
    expect(s.ceo.wakeIds).toEqual([wake.id]);
    expect((await q(`SELECT status, error FROM ceo_batches WHERE id=$1`, [batchId]))[0]).toMatchObject({
      status: 'failed',
      error: 'the shift of this batch is gone',
    });
    r.ended(s.shiftId, 'reported');
    await r.barrier();
  });
});

describe('a running CEO shift', () => {
  it('is not stopped as "claim lost" when the runner reports it in its heartbeat', async () => {
    await clean();
    await wakeNow(w, 'desk_item', 'urgent');
    const s = await startCeoShift(w, r, r.received.length);
    const from = r.received.length;
    r.heartbeat([s.shiftId]);
    await r.barrier();
    expect(r.received.slice(from).filter((f: any) => f.type === 'shift.stop')).toHaveLength(0);
    r.ended(s.shiftId, 'reported');
    await r.barrier();
  });
});

describe('a backlog of wakes', () => {
  it('90 wakes and a review become one small brief: counts per reason and the top items, no inline snapshot', async () => {
    await clean();
    const reasons = ['signal:unclaimed', 'desk_item', 'question', 'signal:update'];
    for (let i = 0; i < 90; i++)
      await wakeNow(w, reasons[i % reasons.length], i % 3 === 0 ? 'urgent' : 'normal');
    await enqueueWake(
      w.t.app.ctx.pool,
      w.owner.id,
      {
        reason: 'daily_review',
        urgency: 'scheduled',
        subjectKind: 'review',
        subjectId: '2026-10-15',
        localDate: '2026-10-15',
      },
      w.t.clock.now(),
    );
    const s = await startCeoShift(w, r, r.received.length);
    expect(s.ceo.purpose).toBe('review');
    expect(s.ceo.wakeIds).toHaveLength(91);
    expect(s.ceo.reasons.length).toBeLessThanOrEqual(MAX_LISTED_WAKES);
    expect(s.ceo.brief.length).toBeLessThan(MAX_BRIEF_CHARS);
    expect(s.ceo.brief).toContain('91 wakes have piled up');
    expect(s.ceo.brief).toMatch(/- signal:unclaimed: 23/);
    expect(s.ceo.brief).toContain('aom ceo snapshot');
    expect(s.ceo.brief).not.toContain('## Organisation snapshot');
    expect(s.ceo.brief.match(/^- \[/gm)?.length ?? 0).toBeLessThanOrEqual(MAX_LISTED_WAKES);
    // the review wake is always among the named ones
    expect(s.ceo.reasons.some((x: any) => x.reason === 'daily_review')).toBe(true);
    expect(JSON.stringify(s).length).toBeLessThan(100_000);
    r.ended(s.shiftId, 'reported');
    await r.barrier();
  });

  it('148 old pending wakes are taken as one batch on the next run, not replayed one by one', async () => {
    await clean();
    const reasons = ['signal:unclaimed', 'desk_item', 'question', 'signal:update', 'signal:loop'];
    for (let i = 0; i < 148; i++) await wakeNow(w, reasons[i % reasons.length], i % 2 ? 'urgent' : 'normal');
    const from = r.received.length;
    const s = await startCeoShift(w, r, from);
    expect(s.ceo.wakeIds).toHaveLength(148);
    expect(s.ceo.brief).toContain('148 wakes have piled up');
    expect(await batches()).toHaveLength(1);
    expect(await wakes('pending')).toHaveLength(0);
    await dispatcher().run();
    await r.barrier();
    expect(
      r.received.slice(from).filter((f: any) => f.type === 'shift.start' && f.kind === 'ceo'),
    ).toHaveLength(1);
    r.ended(s.shiftId, 'reported');
    await r.barrier();
  });
});
