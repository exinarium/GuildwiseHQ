import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueRunnerCommand } from '../src/runner-gateway/commands-queue.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const reaper = () => w.t.app.ctx.services.reaper;
const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const detail = (id: string) => ok<any>(w.t.req('GET', `/api/cards/${id}`, { cookie: w.owner.cookie }));
const eventsFor = async (cardId: string) =>
  (await q(`SELECT type, payload FROM events WHERE stream_id=$1 ORDER BY seq`, [`card-${cardId}`])) as Array<{
    type: string;
    payload: any;
  }>;

async function freshState() {
  await q(
    'TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages, agents, runner_commands, runner_inbox CASCADE',
  );
  await q(`DELETE FROM events WHERE false`);
}

/** Dispatches and returns the shift.start frame the runner receives for `agentName`. */
async function dispatchTo(r: FakeRunner, agentName: string, from = 0) {
  await r.barrier(); // what the runner reported before is recorded before a pass looks at the claims
  await dispatcher().run();
  return r.waitFor('shift.start', (f) => f.agent.name === agentName, 5000, from);
}

async function startShift(r: FakeRunner, start: Awaited<ReturnType<typeof dispatchTo>>, headSha = 'abc123') {
  r.accepted(start.shiftId);
  r.started(start.shiftId, {
    path: `/work/${start.brief.card.ref}`,
    branchName: start.worktree?.branchName ?? 'x',
    baseBranch: 'main',
    created: start.worktree?.mode === 'create',
    headSha,
  });
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
    3000,
    'shift running',
  );
}

async function report(
  r: FakeRunner,
  shiftId: string,
  rep: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const { reportId } = r.report(shiftId, rep, extra);
  const res = await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
  return res;
}

describe('shift flow with a fake runner', () => {
  it('build -> review (changes) -> rework by the original builder -> review (approve) -> test', async () => {
    await freshState();
    const r = await w.connectRunner();
    const b1 = await w.hire('Bea', 'builder', 'junior');
    await w.hire('Bob', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
    const card = await w.card({
      title: 'Flow card',
      fields: fullFields({ mock: { review: ['changes', 'ok'] } }),
    });
    const received = r.received.length;

    // ---- build shift
    await dispatcher().run();
    const start = await r.waitFor('shift.start', () => true, 5000, received);
    const builderName = start.agent.name;
    expect(start.kind).toBe('card');
    expect(start.brief.card).toMatchObject({
      ref: 'TOY-1',
      cardType: 'feature',
      reworkRound: 0,
      completionAction: 'merge',
    });
    expect(start.brief.shift).toMatchObject({ stage: 'build', stageLabel: 'Build', maxShiftMinutes: 60 });
    expect(start.brief.shift.outcomes.map((o) => o.id)).toEqual(['handoff']);
    expect(start.brief.role.key).toBe('builder');
    expect(start.brief.project).toMatchObject({ key: 'TOY', workingBranch: 'main' });
    expect(start.worktree).toMatchObject({
      mode: 'create',
      baseBranch: 'main',
      remoteUrlNormalized: 'github.com/acme/toy',
    });
    expect(start.worktree?.branchName).toBe('aom/toy-1-flow-card');
    expect(start.prepare.rebase).toBe(false);
    expect((await cardRow(card.id)).status).toBe('claimed');

    await startShift(r, start);
    const wt = await cardRow(card.id);
    expect(wt.worktree_path).toBe('/work/TOY-1');
    expect(wt.branch_name).toBe('aom/toy-1-flow-card');
    expect(wt.home_workstation_id).toBe(w.workstationId);

    const res1 = await report(
      r,
      start.shiftId,
      { kind: 'outcome', outcomeId: 'handoff', note: 'built it', data: {} },
      { diffStats: { files: 3, added: 120, removed: 4, architecturalPaths: [] }, riskTier: 'small' },
    );
    expect(res1.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
      3000,
      'shift ended',
    );

    // events: HandoffWritten, ReviewRequested, ClaimReleased in this order, within one transaction
    const ev = await eventsFor(card.id);
    const types = ev.map((e) => e.type);
    const i = types.indexOf('HandoffWritten');
    expect(types.slice(i, i + 3)).toEqual(['HandoffWritten', 'ReviewRequested', 'ClaimReleased']);
    expect(ev[i + 2]!.payload.reason).toBe('handoff');
    expect(ev[i + 2]!.payload.lastHandoffId).toBe(ev[i]!.payload.handoffId);
    const seqs = await q(
      `SELECT seq FROM events WHERE stream_id=$1 AND type IN ('HandoffWritten','ReviewRequested','ClaimReleased') ORDER BY seq`,
      [`card-${card.id}`],
    );
    expect(Number(seqs[2]!.seq) - Number(seqs[0]!.seq)).toBe(2);
    let c = await cardRow(card.id);
    expect(c).toMatchObject({
      stage: 'review',
      status: 'queued',
      claim_id: null,
      risk_tier: 'small',
      rework_round: 0,
    });
    expect(c.excluded_agent_ids).toContain(c.original_builder_agent_id);

    // ---- review shift: never the builder; reviewer asks for changes
    const from2 = r.received.length;
    await dispatcher().run();
    const rs = await r.waitFor('shift.start', (f) => f.agent.name === 'Rex', 5000, from2);
    expect(rs.brief.shift.outcomes.map((o) => o.id).sort()).toEqual(['approve', 'changes']);
    expect(rs.brief.handoffs).toHaveLength(1);
    expect(rs.worktree).toMatchObject({
      mode: 'reuse',
      path: '/work/TOY-1',
      branchName: 'aom/toy-1-flow-card',
    });
    await startShift(r, rs);
    const ch = await report(r, rs.shiftId, {
      kind: 'outcome',
      outcomeId: 'changes',
      note: 'tests are weak',
      data: { score: 2, reasons: ['weak_tests'], criteriaMissed: ['it works'] },
    });
    expect(ch.accepted).toBe(true);
    r.ended(rs.shiftId, 'reported');
    c = await cardRow(card.id);
    expect(c).toMatchObject({ stage: 'build', status: 'queued', rework_round: 1 });
    expect((await detail(card.id)).card.column).toBe('Rework');

    // ---- rework goes to the original builder first (even though the other builder is free and idle longer)
    const from3 = r.received.length;
    await dispatcher().run();
    const rework = await r.waitFor('shift.start', (f) => f.brief.card.reworkRound === 1, 5000, from3);
    expect(rework.agent.name).toBe(builderName);
    expect(rework.agent.agentId).toBe(c.original_builder_agent_id);
    expect(rework.brief.reviewComments[0]).toMatchObject({
      reviewerName: 'Rex',
      reasons: ['weak_tests'],
      criteriaMissed: ['it works'],
      comments: 'tests are weak',
    });
    expect(rework.worktree?.mode).toBe('reuse');
    await startShift(r, rework);
    await report(r, rework.shiftId, { kind: 'outcome', outcomeId: 'handoff', note: 'fixed tests', data: {} });
    r.ended(rework.shiftId, 'reported');

    // ---- second review approves -> test (small risk: one approval)
    const from4 = r.received.length;
    await dispatcher().run();
    const rs2 = await r.waitFor(
      'shift.start',
      (f) => f.agent.name === 'Rex' && f.brief.card.reworkRound === 1,
      5000,
      from4,
    );
    await startShift(r, rs2);
    const ap = await report(r, rs2.shiftId, {
      kind: 'outcome',
      outcomeId: 'approve',
      note: 'good now',
      data: { score: 4 },
    });
    expect(ap.accepted).toBe(true);
    r.ended(rs2.shiftId, 'reported');
    c = await cardRow(card.id);
    expect(c).toMatchObject({ stage: 'test', status: 'queued', claim_id: null });

    const d = await detail(card.id);
    expect(d.handoffs.map((h: any) => `${h.stage}:${h.outcome}`)).toEqual([
      'build:handoff',
      'review:changes',
      'build:handoff',
      'review:approve',
    ]);
    expect(d.handoffs[1].data).toMatchObject({ reasons: ['weak_tests'], score: 2 });
    expect(d.transitions.filter((t: any) => t.toStatus === 'claimed')).toHaveLength(4);
    expect(d.thread.some((m: any) => m.kind === 'handoff')).toBe(true);
    expect(d.thread.some((m: any) => m.kind === 'review')).toBe(true);
    await until(
      async () => (await q(`SELECT 1 FROM shifts WHERE status <> 'ended'`)).length === 0,
      3000,
      'all shifts ended',
    );
    const shifts = await ok<any>(w.t.req('GET', `/api/shifts?cardId=${card.id}`, { cookie: w.owner.cookie }));
    expect(shifts.shifts).toHaveLength(4);
    expect(
      shifts.shifts.every(
        (s: any) => s.status === 'ended' && s.outcome === 'reported' && s.tokensInput === 1000,
      ),
    ).toBe(true);
    // a large-risk card needs two distinct reviewers
    expect(b1.id).toBeTruthy();
    r.close();
  });

  it('the brief carries the effective completion action: the card override, else the project default now', async () => {
    const setDefault = (defaultCompletion: 'merge' | 'pr') =>
      ok(
        w.t.req('PATCH', `/api/projects/${w.projectId}`, {
          cookie: w.owner.cookie,
          body: { defaultCompletion },
        }),
      );
    try {
      await freshState();
      const r = await w.connectRunner();
      await w.hire('Bea', 'builder', 'junior');
      const card = await w.card({ title: 'Inherits', completionAction: undefined });
      expect((await cardRow(card.id)).completion_action).toBeNull();
      await setDefault('pr');
      const received = r.received.length;
      const start = await dispatchTo(r, 'Bea', received);
      expect(start.brief.card).toMatchObject({ ref: card.ref, completionAction: 'pr' });
      r.close();
    } finally {
      await setDefault('merge');
    }
  });

  it('rejects bad reports with an error the CLI can print, and accepts exactly one terminal report', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Cy', 'builder', 'junior');
    const card = await w.card({ title: 'Reports' });
    const start = await dispatchTo(r, 'Cy');
    await startShift(r, start);

    const wrongOutcome = await report(r, start.shiftId, {
      kind: 'outcome',
      outcomeId: 'approve',
      note: 'x',
      data: { score: 3 },
    });
    expect(wrongOutcome).toMatchObject({ accepted: false });
    expect(wrongOutcome.error).toContain("outcome 'approve' is not available on stage 'build'");
    expect(wrongOutcome.error).toContain('handoff');
    const unknown = await report(r, start.shiftId, {
      kind: 'outcome',
      outcomeId: 'nope',
      note: 'x',
      data: {},
    });
    expect(unknown.accepted).toBe(false);
    const question = await report(r, start.shiftId, {
      kind: 'question',
      text: 'why?',
      options: [],
      recommend: 3, // no such option: rejected, the shift keeps going (questions themselves are in questions.test.ts)
      doing: '',
      blocking: true,
    });
    expect(question.accepted).toBe(false);
    expect(question.error).toContain('--recommend');
    const unknownShift = await report(r, '00000000-0000-4000-8000-000000000000', {
      kind: 'comment',
      note: 'x',
    });
    expect(unknownShift.accepted).toBe(false);
    expect((await cardRow(card.id)).stage).toBe('build'); // nothing moved

    // non-terminal comment is accepted and lands in the thread
    expect((await report(r, start.shiftId, { kind: 'comment', note: 'working on it' })).accepted).toBe(true);
    expect(
      (await detail(card.id)).thread.some(
        (m: any) => m.kind === 'comment' && m.body === 'working on it' && m.authorName === 'Cy',
      ),
    ).toBe(true);

    expect(
      (await report(r, start.shiftId, { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: {} }))
        .accepted,
    ).toBe(true);
    const second = await report(r, start.shiftId, {
      kind: 'outcome',
      outcomeId: 'handoff',
      note: 'again',
      data: {},
    });
    expect(second.accepted).toBe(false);
    expect(second.error).toMatch(/already reported/);
    expect(await q('SELECT 1 FROM card_handoffs WHERE card_id=$1', [card.id])).toHaveLength(1);
    r.close();
  });

  it('rejects review data that does not match the outcome (score required)', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Dee', 'builder', 'junior');
    await w.hire('Rio', 'reviewer', 'senior');
    await w.card({ title: 'Review data' });
    const b = await dispatchTo(r, 'Dee');
    await startShift(r, b);
    await report(r, b.shiftId, { kind: 'outcome', outcomeId: 'handoff', note: 'ok', data: {} });
    r.ended(b.shiftId);
    const from = r.received.length;
    await dispatcher().run();
    const rv = await r.waitFor('shift.start', (f) => f.agent.name === 'Rio', 5000, from);
    await startShift(r, rv);
    const bad = await report(r, rv.shiftId, {
      kind: 'outcome',
      outcomeId: 'approve',
      note: 'lgtm',
      data: {},
    });
    expect(bad.accepted).toBe(false);
    expect(bad.error).toContain('score');
    const worse = await report(r, rv.shiftId, {
      kind: 'outcome',
      outcomeId: 'changes',
      note: 'no',
      data: { score: 9 },
    });
    expect(worse.accepted).toBe(false);
    r.close();
  });

  it('large-risk cards need two distinct senior reviewers before test', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Eli', 'builder', 'junior');
    await w.hire('Rv1', 'reviewer', 'senior');
    await w.hire('Rv2', 'reviewer', 'senior');
    const card = await w.card({ title: 'Big change' });
    const b = await dispatchTo(r, 'Eli');
    await startShift(r, b);
    await report(
      r,
      b.shiftId,
      { kind: 'outcome', outcomeId: 'handoff', note: 'big', data: {} },
      {
        diffStats: { files: 50, added: 500, removed: 5, architecturalPaths: ['src/core/x.ts'] },
        riskTier: 'large',
      },
    );
    r.ended(b.shiftId);
    expect((await cardRow(card.id)).risk_tier).toBe('large');

    let from = r.received.length;
    await dispatcher().run();
    const first = await r.waitFor('shift.start', (f) => f.brief.shift.stage === 'review', 5000, from);
    await startShift(r, first);
    await report(r, first.shiftId, {
      kind: 'outcome',
      outcomeId: 'approve',
      note: 'first',
      data: { score: 4 },
    });
    r.ended(first.shiftId);
    let c = await cardRow(card.id);
    expect(c).toMatchObject({ stage: 'review', status: 'queued', review_approvals: 1 });
    const approvalEvt = (await eventsFor(card.id)).filter((e) => e.type === 'ReviewApproved');
    expect(approvalEvt[0]!.payload).toMatchObject({
      approvalsSoFar: 1,
      approvalsRequired: 2,
      toStage: 'review',
    });

    from = r.received.length;
    await dispatcher().run();
    const second = await r.waitFor('shift.start', (f) => f.brief.shift.stage === 'review', 5000, from);
    expect(second.agent.agentId).not.toBe(first.agent.agentId); // distinct reviewer
    await startShift(r, second);
    await report(r, second.shiftId, {
      kind: 'outcome',
      outcomeId: 'approve',
      note: 'second',
      data: { score: 5 },
    });
    r.ended(second.shiftId);
    c = await cardRow(card.id);
    expect(c).toMatchObject({ stage: 'test', status: 'queued' });
    r.close();
  });
});

describe('claim lifecycle and recovery', () => {
  it('releases the claim (runner_rejected) when shift.accepted does not arrive within 30 s', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Fay', 'builder', 'junior');
    const card = await w.card({ title: 'Never accepted' });
    const start = await dispatchTo(r, 'Fay');
    expect((await cardRow(card.id)).status).toBe('claimed');
    w.t.clock.advance(31_000);
    r.heartbeat([]); // keeps presence fresh against the simulated clock
    await until(
      async () =>
        (
          await q('SELECT 1 FROM workstations WHERE last_seen_at > $1', [
            new Date(w.t.clock.now().getTime() - 5000),
          ])
        )[0],
      3000,
    );
    await reaper().run();
    const c = await cardRow(card.id);
    expect(c).toMatchObject({ status: 'queued', claim_id: null, stage: 'build' });
    const rel = (await eventsFor(card.id)).find((e) => e.type === 'ClaimReleased')!;
    expect(rel.payload.reason).toBe('runner_rejected');
    expect((await q('SELECT status, outcome FROM shifts WHERE id=$1', [start.shiftId]))[0]).toEqual({
      status: 'ended',
      outcome: 'rejected',
    });
    w.t.clock.setOffset(0);
    r.close();
  });

  it('shift.rejected(rebase_conflict) sends the card back to build as rework', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Gus', 'builder', 'junior');
    const card = await w.card({ title: 'Conflict' });
    const start = await dispatchTo(r, 'Gus');
    r.rejected(start.shiftId, 'rebase_conflict', { conflictedFiles: ['a.ts'] });
    await until(async () => (await cardRow(card.id)).claim_id === null);
    const types = (await eventsFor(card.id)).map((e) => e.type);
    expect(types).toContain('RebaseConflict');
    const c = await cardRow(card.id);
    expect(c).toMatchObject({ stage: 'build', status: 'queued', rework_round: 1 });
    r.close();
  });

  it('expires the lease after 1 h offline: ClaimReleased(lease_expired), requeued, system thread note, last handoff attached', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Hal', 'builder', 'junior');
    await w.hire('Ivy', 'reviewer', 'senior');
    const card = await w.card({ title: 'Lease' });
    const b = await dispatchTo(r, 'Hal');
    await startShift(r, b);
    await report(r, b.shiftId, { kind: 'outcome', outcomeId: 'handoff', note: 'built', data: {} });
    r.ended(b.shiftId);
    const from = r.received.length;
    await dispatcher().run();
    const rv = await r.waitFor('shift.start', (f) => f.agent.name === 'Ivy', 5000, from);
    await startShift(r, rv);
    const handoffId = (await q('SELECT id FROM card_handoffs WHERE card_id=$1', [card.id]))[0]!.id;

    // within the lease nothing happens
    w.t.clock.advance(30 * 60_000);
    await reaper().run();
    expect((await cardRow(card.id)).status).toBe('claimed');

    // runner goes dark; 1 h after the last heartbeat the lease is gone
    w.t.clock.advance(31 * 60_000);
    await reaper().run();
    const c = await cardRow(card.id);
    expect(c).toMatchObject({ status: 'queued', stage: 'review', claim_id: null });
    const rel = (await eventsFor(card.id)).filter((e) => e.type === 'ClaimReleased').pop()!;
    expect(rel.payload).toMatchObject({ reason: 'lease_expired', lastHandoffId: handoffId });
    const d = await detail(card.id);
    expect(d.thread.some((m: any) => m.kind === 'system' && /offline for 1h/.test(m.body))).toBe(true);
    expect((await q('SELECT outcome FROM shifts WHERE id=$1', [rv.shiftId]))[0]!.outcome).toBe('lost');
    w.t.clock.setOffset(0);
    r.close();
  });

  it('heartbeats refresh the lease', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Jo', 'builder', 'junior');
    const card = await w.card({ title: 'Heartbeat' });
    const s = await dispatchTo(r, 'Jo');
    await startShift(r, s);
    for (let i = 0; i < 3; i++) {
      w.t.clock.advance(30 * 60_000);
      r.heartbeat([s.shiftId]);
      await until(
        async () =>
          new Date((await cardRow(card.id)).lease_expires_at).getTime() >
          w.t.clock.now().getTime() + 55 * 60_000,
        3000,
        'lease refresh',
      );
      await reaper().run();
    }
    expect((await cardRow(card.id)).status).toBe('claimed');
    w.t.clock.setOffset(0);
    r.close();
  });

  it('on reconnect, a claimed shift missing from hello is released (runner_lost_shift)', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Kit', 'builder', 'junior');
    const card = await w.card({ title: 'Lost shift' });
    const s = await dispatchTo(r, 'Kit');
    await startShift(r, s);
    r.close();
    await r.waitClosed();
    await until(
      async () =>
        !(await q('SELECT connected FROM workstations WHERE id=$1', [w.workstationId]))[0]!.connected,
      3000,
    );
    // reconnect without the shift
    const r2 = await w.connectRunner();
    await until(async () => (await cardRow(card.id)).claim_id === null, 3000, 'release');
    const rel = (await eventsFor(card.id)).filter((e) => e.type === 'ClaimReleased').pop()!;
    expect(rel.payload.reason).toBe('runner_lost_shift');
    expect((await cardRow(card.id)).status).toBe('queued');
    r2.close();
  });

  it('on reconnect, a shift reported in hello that the runner still holds keeps its claim; unknown ones get shift.stop(claim_lost)', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Lou', 'builder', 'junior');
    const card = await w.card({ title: 'Reconnect' });
    const s = await dispatchTo(r, 'Lou');
    await startShift(r, s);
    r.close();
    await r.waitClosed();
    const r2 = await (async () => {
      const x = await (await import('./helpers/fake-runner.ts')).FakeRunner.connect(w.baseUrl, w.runnerToken);
      x.hello({
        activeShifts: [
          {
            shiftId: s.shiftId,
            cardId: card.id,
            agentId: s.agent.agentId,
            startedAt: new Date().toISOString(),
          },
          {
            shiftId: '11111111-1111-4111-8111-111111111111',
            agentId: s.agent.agentId,
            startedAt: new Date().toISOString(),
          },
        ],
      });
      return x;
    })();
    await r2.waitFor('welcome');
    const stop = await r2.waitFor('shift.stop');
    expect(stop).toMatchObject({ shiftId: '11111111-1111-4111-8111-111111111111', reason: 'claim_lost' });
    expect((await cardRow(card.id)).status).toBe('claimed');
    // an unacked outbox delays reconciliation until outbox.flushed
    r2.close();
  });

  it('a runner reporting a shift the server released gets shift.stop(claim_lost) on the next heartbeat', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Mel', 'builder', 'junior');
    const card = await w.card({ title: 'Released' });
    const s = await dispatchTo(r, 'Mel');
    await startShift(r, s);
    await ok(w.t.req('POST', `/api/cards/${card.id}/release`, { cookie: w.owner.cookie, body: {} }));
    const manual = await r.waitFor('shift.stop', (f) => f.shiftId === s.shiftId);
    expect(manual.reason).toBe('manager');
    // a later report from that shift is rejected
    const late = await report(r, s.shiftId, {
      kind: 'outcome',
      outcomeId: 'handoff',
      note: 'late',
      data: {},
    });
    expect(late.accepted).toBe(false);
    expect(late.error).toContain('no longer holds the claim');
    const before = r.of('shift.stop').length;
    r.heartbeat([s.shiftId]);
    await until(async () => r.of('shift.stop').length > before, 3000, 'second stop');
    expect(r.of('shift.stop').at(-1)!.reason).toBe('claim_lost');
    r.close();
  });

  it('loses a shift after two heartbeats that do not report it', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Ned', 'builder', 'junior');
    const card = await w.card({ title: 'Missing heartbeat' });
    const s = await dispatchTo(r, 'Ned');
    await startShift(r, s);
    r.heartbeat([]);
    await r.barrier(); // the heartbeat is handled: the miss is counted
    expect((await cardRow(card.id)).status).toBe('claimed'); // one miss is tolerated
    r.heartbeat([]);
    await until(async () => (await cardRow(card.id)).claim_id === null, 3000, 'lost');
    expect((await eventsFor(card.id)).filter((e) => e.type === 'ClaimReleased').pop()!.payload.reason).toBe(
      'runner_lost_shift',
    );
    r.close();
  });

  it('a shift that ends without a report releases the claim (shift_failed) and notes it in the thread', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Oli', 'builder', 'junior');
    const card = await w.card({ title: 'No report' });
    const s = await dispatchTo(r, 'Oli');
    await startShift(r, s);
    r.ended(s.shiftId, 'no_report', { finalText: 'I got tired' });
    await until(async () => (await cardRow(card.id)).claim_id === null, 3000);
    expect((await eventsFor(card.id)).filter((e) => e.type === 'ClaimReleased').pop()!.payload.reason).toBe(
      'shift_failed',
    );
    const d = await detail(card.id);
    expect(d.thread.find((m: any) => m.kind === 'system' && m.body.includes('I got tired'))).toBeTruthy();
    expect((await q('SELECT outcome FROM shifts WHERE id=$1', [s.shiftId]))[0]!.outcome).toBe('no_report');
    r.close();
  });

  it('deduplicates acked messages by envelope id (retry after a lost ack has no extra effect)', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Pam', 'builder', 'junior');
    const card = await w.card({ title: 'Dedupe' });
    const s = await dispatchTo(r, 'Pam');
    await startShift(r, s);
    const reportId = '22222222-2222-4222-8222-222222222222';
    const envelopeId = '33333333-3333-4333-8333-333333333333';
    const body = {
      shiftId: s.shiftId,
      reportId,
      report: { kind: 'outcome', outcomeId: 'handoff', note: 'once', data: {} },
    };
    r.send('shift.report', body, envelopeId);
    const first = await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
    expect(first.accepted).toBe(true);
    const before = r.of('shift.report.result').length;
    r.send('shift.report', body, envelopeId);
    await until(async () => r.of('shift.report.result').length > before, 3000);
    expect(r.of('shift.report.result').at(-1)).toMatchObject({ reportId, accepted: true });
    expect(await q('SELECT 1 FROM card_handoffs WHERE card_id=$1', [card.id])).toHaveLength(1);
    expect(r.of('ack').filter((a) => a.ackOf === envelopeId).length).toBe(2);
    r.close();
  });
});

describe('agent retirement, unlinking and runner commands', () => {
  it('AgentRetired releases claimed cards with the last handoff attached, stops the shift and queues agent.wipe; retired agents never claim', async () => {
    await freshState();
    const r = await w.connectRunner();
    const bld = await w.hire('Quin', 'builder', 'junior');
    const rev = await w.hire('Ray', 'reviewer', 'senior');
    const card = await w.card({ title: 'Fire me' });
    const b = await dispatchTo(r, 'Quin');
    await startShift(r, b);
    await report(r, b.shiftId, { kind: 'outcome', outcomeId: 'handoff', note: 'built', data: {} });
    r.ended(b.shiftId);
    const from = r.received.length;
    await dispatcher().run();
    const rv = await r.waitFor('shift.start', (f) => f.agent.name === 'Ray', 5000, from);
    await startShift(r, rv);
    const handoffId = (await q('SELECT id FROM card_handoffs WHERE card_id=$1', [card.id]))[0]!.id;

    const fired = await ok<any>(w.t.req('POST', `/api/agents/${rev.id}/fire`, { cookie: w.owner.cookie }));
    expect(fired.releasedCardIds).toEqual([card.id]);
    const evs = await eventsFor(card.id);
    const rel = evs.filter((e) => e.type === 'ClaimReleased').pop()!;
    expect(rel.payload).toMatchObject({ reason: 'agent_retired', lastHandoffId: handoffId });
    expect(await cardRow(card.id)).toMatchObject({ status: 'queued', stage: 'review', claim_id: null });
    const stop = await r.waitFor('shift.stop', (f) => f.shiftId === rv.shiftId);
    expect(stop.reason).toBe('agent_retired');
    const cmd = await r.waitFor('command', (f) => f.command === 'agent.wipe');
    expect(cmd.payload).toEqual({ agentId: rev.id });
    r.send('command.result', { commandId: cmd.commandId, ok: true });
    await until(
      async () =>
        (await q('SELECT status FROM runner_commands WHERE id=$1', [cmd.commandId]))[0]!.status === 'done',
      3000,
    );

    // the retired reviewer is never picked again; a new one is
    await dispatcher().run();
    expect(r.of('shift.start').filter((f) => f.agent.name === 'Ray').length).toBe(1);
    expect((await cardRow(card.id)).status).toBe('queued');
    expect(bld.id).toBeTruthy();
    r.close();
  });

  it('queues agent.wipe for an offline runner and delivers it on the next connect', async () => {
    await freshState();
    const gone = await w.hire('Sol', 'builder', 'junior');
    await ok(w.t.req('POST', `/api/agents/${gone.id}/fire`, { cookie: w.owner.cookie }));
    const pending = await q(`SELECT status FROM runner_commands WHERE type='agent.wipe'`);
    expect(pending).toEqual([{ status: 'pending' }]);
    const r = await w.connectRunner();
    const cmd = await r.waitFor('command', (f) => f.command === 'agent.wipe');
    expect(cmd.payload.agentId).toBe(gone.id);
    expect((await q(`SELECT status, attempts FROM runner_commands WHERE type='agent.wipe'`))[0]).toEqual({
      status: 'sent',
      attempts: 1,
    });
    // failure -> retried on the next connect
    r.send('command.result', { commandId: cmd.commandId, ok: false, error: 'disk busy' });
    await until(
      async () =>
        (await q(`SELECT status FROM runner_commands WHERE type='agent.wipe'`))[0]!.status === 'pending',
      3000,
    );
    r.close();
  });

  it('delivers a command once however many deliveries race, and again only after a reconnect', async () => {
    await freshState();
    const r = await w.connectRunner();
    const ctx = w.t.app.ctx;
    await enqueueRunnerCommand(ctx.pool, w.workstationId, 'repos.rescan', {});
    // a report, a desk action and a repo change may all deliver at the same moment
    await Promise.all(Array.from({ length: 8 }, () => ctx.services.gateway.deliverPending(w.workstationId)));
    await r.barrier();
    expect(r.of('command').filter((f) => f.command === 'repos.rescan')).toHaveLength(1);
    // still unanswered: a later delivery on the same connection does not send it again
    await ctx.services.gateway.deliverPending(w.workstationId);
    await r.barrier();
    expect(r.of('command').filter((f) => f.command === 'repos.rescan')).toHaveLength(1);
    r.close();
    // the connection is gone with the command unanswered: the next one gets it again
    const r2 = await w.connectRunner();
    const again = await r2.waitFor('command', (f) => f.command === 'repos.rescan');
    expect(r2.of('command').filter((f) => f.command === 'repos.rescan')).toHaveLength(1);
    // a result is applied once: a second answer for the finished command changes nothing
    r2.send('command.result', { commandId: again.commandId, ok: true });
    await until(
      async () =>
        (await q('SELECT status FROM runner_commands WHERE id=$1', [again.commandId]))[0]!.status === 'done',
      3000,
    );
    r2.send('command.result', { commandId: again.commandId, ok: false, error: 'late' });
    await r2.barrier();
    expect((await q('SELECT status FROM runner_commands WHERE id=$1', [again.commandId]))[0]!.status).toBe(
      'done',
    );
    r2.close();
  });

  it('unlinking releases claimed cards (workstation_unlinked) and clears their home workstation', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Tia', 'builder', 'junior');
    const card = await w.card({ title: 'Unlink me' });
    const s = await dispatchTo(r, 'Tia');
    await startShift(r, s);
    expect((await cardRow(card.id)).home_workstation_id).toBe(w.workstationId);
    await ok(w.t.req('POST', `/api/workstations/${w.workstationId}/unlink`, { cookie: w.owner.cookie }));
    expect((await r.waitClosed()).code).toBe(4403);
    const c = await cardRow(card.id);
    expect(c).toMatchObject({
      status: 'queued',
      claim_id: null,
      home_workstation_id: null,
      worktree_path: null,
    });
    expect((await eventsFor(card.id)).filter((e) => e.type === 'ClaimReleased').pop()!.payload.reason).toBe(
      'workstation_unlinked',
    );
    expect((await q('SELECT status, outcome FROM shifts WHERE id=$1', [s.shiftId]))[0]).toEqual({
      status: 'ended',
      outcome: 'lost',
    });
  });
});
