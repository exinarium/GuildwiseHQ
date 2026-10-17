import { DESK_SUBKIND } from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listDevopsAudit, listRunnerErrors } from '../src/commands/runner-telemetry.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  await freshState();
  await q(
    'TRUNCATE runner_errors, runner_error_workstations, devops_audit, workstation_role_blocks RESTART IDENTITY CASCADE',
  );
  w.t.app.ctx.services.dispatcher.cooldown.clear();
});

const shiftRow = async (id: string) => (await q('SELECT * FROM shifts WHERE id=$1', [id]))[0]!;
const eventsOf = async (type: string) =>
  (await q('SELECT payload FROM events WHERE type=$1 ORDER BY seq', [type])).map((e) => e.payload);

async function startedShift(agent = 'Bea') {
  await w.hire(agent, 'builder', 'junior');
  await w.card({ title: 'Telemetry card' });
  const start = await p.next(agent);
  await p.startShift(r, start);
  return start;
}

describe('shift.session: the session id arrives after shift.started', () => {
  it('stores runtime_session_id (it was empty for all shifts) and the context size on the shift', async () => {
    const start = await startedShift();
    expect((await shiftRow(start.shiftId)).runtime_session_id).toBeNull();
    r.send('shift.session', {
      shiftId: start.shiftId,
      runtimeSessionId: 'sess-123',
      contextTokens: 41_000,
      resume: { state: 'fresh_too_large', detail: '130K context tokens (limit 120K)' },
    });
    await until(
      async () => (await shiftRow(start.shiftId)).runtime_session_id === 'sess-123',
      3000,
      'session',
    );
    const row = await shiftRow(start.shiftId);
    expect(row.context_tokens).toBe(41_000);
    expect(row.resume_state).toBe('fresh_too_large');
    // an event, so a replay rebuilds the columns
    expect((await eventsOf('ShiftSessionRecorded')).at(-1)).toMatchObject({
      shiftId: start.shiftId,
      runtimeSessionId: 'sess-123',
      contextTokens: 41_000,
      resumeState: 'fresh_too_large',
    });
  });

  it('a later update with only the context size keeps the session id', async () => {
    const start = await startedShift();
    r.send('shift.session', { shiftId: start.shiftId, runtimeSessionId: 'sess-9', contextTokens: 10_000 });
    r.send('shift.session', { shiftId: start.shiftId, runtimeSessionId: 'sess-9', contextTokens: 70_000 });
    await until(async () => (await shiftRow(start.shiftId)).context_tokens === 70_000, 3000, 'context');
    expect((await shiftRow(start.shiftId)).runtime_session_id).toBe('sess-9');
  });

  it('shift.ended carries the final context size', async () => {
    const start = await startedShift();
    r.ended(start.shiftId, 'no_report', { contextTokens: 88_000 });
    await until(async () => (await shiftRow(start.shiftId)).status === 'ended', 3000, 'ended');
    expect((await shiftRow(start.shiftId)).context_tokens).toBe(88_000);
  });

  it('an unknown shift is ignored', async () => {
    const before = (await eventsOf('ShiftSessionRecorded')).length;
    r.send('shift.session', {
      shiftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789ff',
      runtimeSessionId: 'x',
    });
    await r.barrier();
    expect(await eventsOf('ShiftSessionRecorded')).toHaveLength(before);
  });
});

describe('runner.error: stored once per signature, with a counter', () => {
  const err = (over: Record<string, unknown> = {}) => ({
    signature: 'TypeError:doThing (aom-runner.mjs):abcdef0123',
    message: 'cannot read x',
    stack: 'at doThing (aom-runner.mjs:1:1)',
    version: '0.1.24',
    context: 'shift.card',
    ...over,
  });

  it('dedupes by signature and counts the occurrences', async () => {
    r.send('runner.error', err());
    r.send('runner.error', err({ version: '0.1.25' }));
    r.send('runner.error', err({ signature: 'Error:other:0000000001', message: 'other', stack: undefined }));
    await r.barrier();
    const list = await listRunnerErrors(w.t.app.ctx);
    expect(list).toHaveLength(2);
    const a = list.find((e) => e.signature.startsWith('TypeError'))!;
    expect(a).toMatchObject({
      occurrences: 2,
      firstVersion: '0.1.24',
      lastVersion: '0.1.25',
      workstationCount: 1,
      message: 'cannot read x',
      bugCardId: null,
    });
    expect(list.find((e) => e.signature.startsWith('Error:other'))?.occurrences).toBe(1);
  });

  it('a redelivered message (same id) counts once', async () => {
    const id = r.send('runner.error', err());
    r.send('runner.error', err(), id);
    await r.barrier();
    expect((await listRunnerErrors(w.t.app.ctx))[0]?.occurrences).toBe(1);
  });

  it('the platform route is for the super admin only', async () => {
    const res = await w.t.req('GET', '/api/platform/runner-errors', { cookie: w.owner.cookie });
    expect([401, 403, 404]).toContain(res.status);
  });
});

describe('devops.audit: every command of the DevOps engineer is stored', () => {
  it('stores allowed and refused commands with the rule', async () => {
    r.send('devops.audit', {
      entries: [
        {
          at: '2026-10-17T10:00:00.000Z',
          sessionRef: 'shift-1',
          kind: 'shift',
          decision: 'allowed',
          rule: 'ok',
          command: 'docker ps',
        },
        {
          at: '2026-10-17T10:00:05.000Z',
          sessionRef: 'shift-1',
          kind: 'shift',
          decision: 'refused',
          rule: 'off_workstation',
          command: 'ssh uat ls',
        },
        {
          at: '2026-10-17T10:01:00.000Z',
          sessionRef: 'chat-1',
          kind: 'chat',
          decision: 'refused',
          rule: 'user_admin',
          command: 'sudo reboot',
        },
      ],
    });
    await r.barrier();
    const all = await listDevopsAudit(w.t.app.ctx);
    expect(all.map((e) => e.command)).toEqual(['sudo reboot', 'ssh uat ls', 'docker ps']);
    const refused = await listDevopsAudit(w.t.app.ctx, { refusedOnly: true });
    expect(refused.map((e) => e.rule)).toEqual(['user_admin', 'off_workstation']);
    expect(all.every((e) => e.workstation_id === w.workstationId)).toBe(true);
  });
});

describe('role.smoke: a failed role gets no work on this workstation', () => {
  const smoke = (results: Array<{ roleKey: string; ok: boolean; detail?: string }>) =>
    r.send('role.smoke', { runnerVersion: '0.1.24', results });
  const openItems = async () =>
    q(`SELECT * FROM desk_items WHERE subkind=$1 AND status='open'`, [DESK_SUBKIND.roleSmokeFailed]);

  it('blocks the role, raises one desk item (not one per report) and resumes when the test passes again', async () => {
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
    await w.card({ title: 'Needs a builder' });
    smoke([
      { roleKey: 'builder', ok: false, detail: '`aom handoff` failed (exit 1): cannot reach the runner' },
      { roleKey: 'reviewer', ok: true },
    ]);
    await r.barrier();
    expect(await q('SELECT role_key, detail FROM workstation_role_blocks')).toEqual([
      { role_key: 'builder', detail: '`aom handoff` failed (exit 1): cannot reach the runner' },
    ]);
    // no work for the builder here
    const starts = r.of('shift.start').length;
    await q('UPDATE workstations SET last_seen_at=$1 WHERE connected', [w.t.clock.now()]);
    await w.t.app.ctx.services.dispatcher.run();
    await r.barrier();
    expect(r.of('shift.start')).toHaveLength(starts);
    // one item, naming the role and the reason
    let items = await openItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toMatch(/builder cannot work on/);
    expect(items[0]?.body).toMatch(/cannot reach the runner/);
    // the same failure again does not raise a second item
    smoke([{ roleKey: 'builder', ok: false, detail: 'still failing' }]);
    await r.barrier();
    items = await openItems();
    expect(items).toHaveLength(1);
    // the next run passes: the block and the item go, the builder works again
    smoke([
      { roleKey: 'builder', ok: true },
      { roleKey: 'reviewer', ok: true },
    ]);
    await r.barrier();
    expect(await q('SELECT 1 FROM workstation_role_blocks')).toHaveLength(0);
    expect(await openItems()).toHaveLength(0);
    const start = await p.next('Bea');
    expect(start.agent.name).toBe('Bea');
  });
});

describe('disk_full rejection holds the card back (#81)', () => {
  it('a worktree_failed that says disk_full backs the card off instead of re-offering it at once', async () => {
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Disk card' });
    const start = await p.next('Bea');
    r.rejected(start.shiftId, 'worktree_failed', {
      detail:
        'disk_full: /tmp has 0 MB free (needs 512 MB). No shift can start on this workstation until space is freed.',
    });
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
      3000,
      'ended',
    );
    const row = (await q('SELECT retry_after, retry_failures FROM cards WHERE id=$1', [card.id]))[0]!;
    expect(row.retry_after).not.toBeNull();
    expect(Number(row.retry_failures)).toBe(1);
  });
});
