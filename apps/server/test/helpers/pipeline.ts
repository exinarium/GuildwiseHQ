import { q } from './db.ts';
import type { FakeRunner } from './fake-runner.ts';
import { shiftHelpers } from './shifts.ts';
import { until, type World } from './world.ts';

export const DIFF_SMALL = {
  diffStats: { files: 2, added: 10, removed: 1, architecturalPaths: [] },
  riskTier: 'small',
};
export const DIFF_LARGE = {
  diffStats: { files: 9, added: 300, removed: 20, architecturalPaths: ['src/core/x.ts'] },
  riskTier: 'large',
};

export const handoff = (note = 'done') => ({ kind: 'outcome', outcomeId: 'handoff', note, data: {} });
export const approve = (note = 'looks good') => ({
  kind: 'outcome',
  outcomeId: 'approve',
  note,
  data: { score: 4 },
});
export const changes = (reasons: string[] = ['missed_requirement'], note = 'fix it') => ({
  kind: 'outcome',
  outcomeId: 'changes',
  note,
  data: { score: 2, reasons, criteriaMissed: ['c1'] },
});
export const testPass = (summary = '3 passed') => ({
  kind: 'outcome',
  outcomeId: 'pass',
  note: summary,
  data: { summary, commands: ['pnpm e2e'], outputExcerpt: 'ok' },
});
export const testFail = (title = 'Login is broken', summary = '1 failed') => ({
  kind: 'outcome',
  outcomeId: 'fail',
  note: 'Steps: open login, submit. Expected redirect, got 500.',
  data: { summary, commands: ['pnpm e2e'], outputExcerpt: 'Error: 500', title },
});

export const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
export const eventsOfType = async (type: string) =>
  (await q('SELECT payload FROM events WHERE type=$1 ORDER BY seq', [type])).map((e) => e.payload);

/** Dispatches the next shift to `agentName`, runs it to `report` and waits until the shift ended. */
export function pipeline(w: World, r: FakeRunner) {
  const h = shiftHelpers(w);
  const used = new Set<string>();
  /** The next not yet consumed `shift.start` for `agentName` (dispatching may already have happened eagerly). */
  async function next(agentName: string) {
    await h.dispatcher().run();
    const start = (await r.waitFor(
      'shift.start',
      (f) => f.agent.name === agentName && !used.has(f.shiftId),
    )) as any;
    used.add(start.shiftId);
    return start as Awaited<ReturnType<typeof h.dispatchTo>>;
  }
  async function run(
    agentName: string,
    report: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const start = await next(agentName);
    await h.startShift(r, start);
    const res = await h.report(r, start.shiftId, report, extra);
    r.ended(start.shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
      3000,
      'shift ended',
    );
    return { start, res };
  }
  /** Dispatches `agentName` and rejects the shift (runner side problem before the agent started). */
  async function reject(agentName: string, reason: string, extra: Record<string, unknown> = {}) {
    const start = await next(agentName);
    r.rejected(start.shiftId, reason, extra);
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
      3000,
      'shift ended',
    );
    return start;
  }
  /** build -> review (as many approvals as the tier needs) until the card waits in Test. */
  async function toTest(builder: string, reviewers: string[], diff = DIFF_SMALL) {
    await run(builder, handoff(), diff);
    for (const rv of reviewers) await run(rv, approve());
  }
  return { ...h, next, run, reject, toTest };
}

export async function hireTeam(w: World, extra: { reviewers?: string[]; builders?: string[] } = {}) {
  for (const b of extra.builders ?? ['Bea']) await w.hire(b, 'builder', 'junior');
  for (const rv of extra.reviewers ?? ['Rex']) await w.hire(rv, 'reviewer', 'senior');
  await w.hire('Tess', 'tester', 'junior');
}
