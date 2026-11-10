import { hireDevopsForOrgIn } from '../../src/commands/devops.ts';
import { withAppendTx } from '../../src/db/tx.ts';
import { q } from './db.ts';
import type { FakeRunner } from './fake-runner.ts';
import { until, type World } from './world.ts';

export type ShiftStart = Awaited<ReturnType<FakeRunner['waitFor']>> & { type: 'shift.start' };

/** Truncates the M1+M2 domain tables between tests of one file. */
export async function freshState(): Promise<void> {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages, agents,
       desk_items, card_blockers, ledger_entries, runner_commands, runner_inbox CASCADE`,
  );
}

/**
 * The workstation's DevOps engineer (auto-hired at pairing, wiped by `freshState`): back for tests of work only the DevOps
 * engineer does (release prep, GWP-189). Its runtime is the mock runtime the fake runner reports.
 */
export async function hireDevopsEngineer(w: World): Promise<{ id: string; name: string }> {
  const ws = (await q('SELECT user_id FROM workstations WHERE id=$1', [w.workstationId]))[0] as {
    user_id: string;
  };
  const orgs = await q(
    `SELECT org_id FROM org_members WHERE user_id=$1 AND status='active' ORDER BY joined_at`,
    [ws.user_id],
  );
  const orgId = (orgs[0] as { org_id: string }).org_id;
  await withAppendTx(w.t.app.ctx.pool, (tx) => hireDevopsForOrgIn(w.t.app.ctx, tx, ws.user_id, orgId));
  await q(`UPDATE agents SET runtime='mock', model='mock' WHERE workstation_id=$1 AND is_devops`, [
    w.workstationId,
  ]);
  return (
    await q(`SELECT id, name FROM agents WHERE workstation_id=$1 AND is_devops AND status='active'`, [
      w.workstationId,
    ])
  )[0] as { id: string; name: string };
}

export function shiftHelpers(w: World) {
  const dispatcher = () => w.t.app.ctx.services.dispatcher;

  /** Runs a dispatch pass and returns the `shift.start` the runner receives for `agentName` (after `from` frames). */
  async function dispatchTo(r: FakeRunner, agentName: string, from = 0): Promise<ShiftStart> {
    // Everything the runner reported before (a shift ended, a report) must be recorded: a pass that starts earlier
    // sees the old claim and, with no timer-driven dispatch in tests, nothing would run it again.
    await r.barrier();
    await dispatcher().run();
    return (await r.waitFor('shift.start', (f) => f.agent.name === agentName, 5000, from)) as ShiftStart;
  }

  async function startShift(r: FakeRunner, start: ShiftStart, headSha = 'abc123') {
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
    return r.waitFor('shift.report.result', (f) => f.reportId === reportId);
  }

  return { dispatcher, dispatchTo, startShift, report };
}
