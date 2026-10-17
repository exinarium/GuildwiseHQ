import { randomUUID } from 'node:crypto';
import { q } from './db.ts';
import type { FakeRunner } from './fake-runner.ts';
import { pipeline } from './pipeline.ts';
import { until, type World } from './world.ts';

/** Helpers of the code-v6 suites (lean team workflow). */
export const SHA1 = 'a1'.repeat(20);
export const SHA2 = 'b2'.repeat(20);

export const EVIDENCE = {
  commands: [
    { kind: 'build', command: 'pnpm build', status: 'passed', result: 'ok' },
    { kind: 'test', command: 'pnpm test', status: 'passed', result: '3 passed' },
  ],
};

/** What the runner attaches to a build handoff of code-v6: the diff stats, the measured head, the paths and the diff. */
export const leanAttach = (
  sha = SHA1,
  paths: string[] = ['src/feature.ts'],
  over: Record<string, unknown> = {},
) => ({
  diffStats: { files: paths.length, added: 10, removed: 1, architecturalPaths: [] },
  riskTier: 'small',
  headSha: sha,
  changedPaths: paths,
  diff: {
    text: `diff --git a/${paths[0]} b/${paths[0]}\n--- a/${paths[0]}\n+++ b/${paths[0]}\n@@ -1 +1 @@\n-old\n+new\n`,
    bytes: 90,
    truncated: false,
    base: 'origin/main',
  },
  ...over,
});

export const handoffEv = (evidence: unknown = EVIDENCE, note = 'built') => ({
  kind: 'outcome',
  outcomeId: 'handoff',
  note,
  data: evidence === null ? {} : { buildEvidence: evidence },
});
export const planned = (note = 'planning note') => ({
  kind: 'outcome',
  outcomeId: 'planned',
  note,
  data: {},
});
export const designed = (ref = 'TOY-1') => ({
  kind: 'outcome',
  outcomeId: 'handoff',
  note: 'designed',
  data: {
    reportPath: `docs/investigations/${ref}-report.md`,
    summary: 'Build it in module X.',
    location: 'repo',
    commit: 'abc1234',
  },
});
export const verdict = (outcomeId: 'approve' | 'changes', extra: Record<string, unknown> = {}) => ({
  kind: 'outcome',
  outcomeId,
  note: `${outcomeId} note`,
  data:
    outcomeId === 'approve'
      ? { score: 4, risk: 'low', riskAnalysis: 'x', ...extra }
      : { score: 2, reasons: ['missed_requirement'], criteriaMissed: ['c1'], ...extra },
});

/** `pipeline().run`, with the commit the shift starts at (the runner reports it in `shift.started`). */
export function leanPipeline(w: World, r: FakeRunner) {
  const p = pipeline(w, r);
  /**
   * The next shift.start for an agent whose card still exists: dispatching is eager, so the frames of earlier tests'
   * cards (truncated since) can still be waiting in the fake runner's list.
   */
  async function next(agentName: string) {
    for (;;) {
      const start = await p.next(agentName);
      if ((await q('SELECT 1 FROM cards WHERE id=$1', [start.brief.card.id])).length > 0) return start;
    }
  }
  async function runAt(
    agentName: string,
    report: Record<string, unknown>,
    extra: Record<string, unknown> = {},
    sha = SHA1,
    startExtra: { rebased?: boolean } = {},
  ) {
    const start = await next(agentName);
    r.accepted(start.shiftId);
    r.started(start.shiftId, {
      path: `/work/${start.brief.card.ref}`,
      branchName: start.worktree?.branchName ?? 'x',
      baseBranch: 'main',
      created: start.worktree?.mode === 'create',
      headSha: sha,
      ...startExtra,
    });
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
      3000,
      'shift running',
    );
    const res = await p.report(r, start.shiftId, report, extra);
    r.ended(start.shiftId, 'reported');
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
      3000,
      'shift ended',
    );
    return { start, res };
  }
  const run = (agentName: string, report: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    runAt(agentName, report, extra, SHA1);
  return { ...p, next, run, runAt };
}

export async function resetLean(): Promise<void> {
  await q('TRUNCATE card_groups, card_diffs');
}

/** Like `freshState`, but keeps the workstation's DevOps engineer (the test deploy and the conflict attempt need it). */
export async function freshKeepDevops(): Promise<void> {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages,
       desk_items, card_blockers, ledger_entries, devops_requests, runner_commands, runner_inbox,
       run_environments, run_plans, test_suite_results, card_groups, card_diffs CASCADE`,
  );
  await q('DELETE FROM agents WHERE NOT is_devops');
}

export const rpcOf =
  (r: FakeRunner) =>
  async (shiftId: string, method: string, params: Record<string, unknown> = {}) => {
    const rpcId = randomUUID();
    const from = r.received.length;
    r.send('rpc.request', { rpcId, shiftId, method, params });
    return r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from);
  };

export async function hireLeanTeam(
  w: World,
  extra: { reviewers?: string[]; builders?: string[] } = {},
): Promise<void> {
  await w.hire('Pia', 'planner', 'junior');
  await w.hire('Arc', 'architect', 'senior');
  for (const b of extra.builders ?? ['Bea']) await w.hire(b, 'builder', 'junior');
  await w.hire('Pre', 'pre_reviewer', 'junior');
  for (const rv of extra.reviewers ?? ['Rex']) await w.hire(rv, 'reviewer', 'senior');
  await w.hire('Tess', 'tester', 'junior');
}
