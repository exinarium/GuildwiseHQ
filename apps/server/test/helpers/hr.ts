import { q } from './db.ts';
import { changes, DIFF_LARGE, DIFF_SMALL, handoff } from './pipeline.ts';
import { ok, type World } from './world.ts';

export const diffWithTests = (n: number, base = DIFF_SMALL) => ({
  ...base,
  diffStats: { ...base.diffStats, testFiles: n },
});

/** A review verdict with an explicit score, reasons and missed criteria. */
export const bounce = (
  score: number,
  reasons: string[] = ['missed_requirement'],
  criteriaMissed: string[] = [],
  note = 'fix it',
) => ({ kind: 'outcome', outcomeId: 'changes', note, data: { score, reasons, criteriaMissed } });
export const approveWith = (score: number, note = 'looks good') => ({
  kind: 'outcome',
  outcomeId: 'approve',
  note,
  data: { score },
});

export { changes, DIFF_LARGE, DIFF_SMALL, handoff };

/** Clears the per-test state (cards, agents, desk, ledger, track record) but keeps users, project, workstation. */
export async function resetHr(): Promise<void> {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages, agents,
       desk_items, card_blockers, ledger_entries, runner_commands, runner_inbox, hr_applied CASCADE`,
  );
}

export const recommendations = async (w: World, cookie = w.owner.cookie): Promise<any[]> =>
  (await ok<any>(w.t.req('GET', '/api/hr/recommendations', { cookie }))).recommendations;
export const kindsOf = (recs: any[]) => recs.map((r) => r.kind).sort();
export const board = (w: World, cookie = w.owner.cookie, qs = ''): Promise<any> =>
  ok<any>(w.t.req('GET', `/api/hr/board${qs}`, { cookie }));
