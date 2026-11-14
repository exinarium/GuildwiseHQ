import { PR_REVIEW_CAPABILITY, type ReviewerTokenState } from '@aom/shared';
import { listReviewEligiblePrs, type ReviewEligiblePr } from '../commands/pr-only.ts';
import { type Queryable, rows } from '../db/sql.ts';

/**
 * Whether a PR-only repository may get reviewer runs: at least one active workstation of an active project member
 * reports a comment-only reviewer token for it. The server holds only that fact (`workstation_repos.reviewer_token`),
 * never the token.
 */
export type ReviewerGate =
  | { state: 'not_pr_only' }
  | { state: 'reviewer_token_missing'; problem: 'unreadable' | 'unsupported_host' | null }
  | { state: 'ready'; workstationIds: string[] };

interface GateRow {
  workstation_id: string;
  reviewer_token: boolean | null;
  reviewer_token_problem: string | null;
}

/** The workstations of active project members that hold a clone of the repository, best first. */
async function gateRows(db: Queryable, projectRepoId: string): Promise<GateRow[]> {
  return (await rows(
    db,
    `SELECT w.id AS workstation_id, wr.reviewer_token, wr.reviewer_token_problem
       FROM workstation_repos wr
       JOIN workstations w ON w.id = wr.workstation_id AND w.status = 'active'
       JOIN project_repos r ON r.id = wr.project_repo_id
       JOIN project_members pm ON pm.project_id = r.project_id AND pm.user_id = w.user_id AND pm.status = 'active'
      WHERE wr.project_repo_id = $1
      ORDER BY w.connected DESC, w.last_seen_at DESC NULLS LAST`,
    [projectRepoId],
  )) as unknown as GateRow[];
}

export async function reviewerGate(db: Queryable, projectRepoId: string): Promise<ReviewerGate> {
  const repo = await rows(db, 'SELECT pr_only, removed_at FROM project_repos WHERE id = $1', [projectRepoId]);
  const r = repo[0];
  if (!r || !r.pr_only || r.removed_at) return { state: 'not_pr_only' };
  const list = await gateRows(db, projectRepoId);
  const ready = list.filter((g) => g.reviewer_token === true && !g.reviewer_token_problem);
  if (ready.length > 0) return { state: 'ready', workstationIds: ready.map((g) => g.workstation_id) };
  const problem = list.find((g) => g.reviewer_token_problem)?.reviewer_token_problem;
  return {
    state: 'reviewer_token_missing',
    problem: problem === 'unreadable' || problem === 'unsupported_host' ? problem : null,
  };
}

/** What the owner sees per PR-only repository: `present` when the gate is ready, else `missing`. */
export async function reviewerTokenStates(
  db: Queryable,
  repoIds: string[],
): Promise<Map<string, ReviewerTokenState>> {
  const out = new Map<string, ReviewerTokenState>();
  for (const id of repoIds)
    out.set(id, (await reviewerGate(db, id)).state === 'ready' ? 'present' : 'missing');
  return out;
}

/** At most this many reviewer runs at once on one workstation. */
export const MAX_RUNNING_PER_WORKSTATION = 2;

export type WorkstationPick =
  | { id: string }
  | { busy: true }
  | { blocked: 'runner_outdated' | 'workstation_offline' };

/**
 * The workstation a reviewer run goes to, among those that hold the token (`gate.workstationIds`, best first):
 * needs the `pr-review:1` capability (else `runner_outdated`), to be connected (else `workstation_offline`) and, unless
 * `ignoreBusy`, fewer than `MAX_RUNNING_PER_WORKSTATION` running reviews (else `busy`: a concurrency wait, not blocked).
 */
export async function pickReviewerWorkstation(
  db: Queryable,
  gate: { workstationIds: string[] },
  opts: { ignoreBusy?: boolean } = {},
): Promise<WorkstationPick> {
  const capable = await rows(
    db,
    `SELECT w.id, w.connected,
            (SELECT count(*)::int FROM pr_review_runs x WHERE x.workstation_id = w.id AND x.state='running') AS busy
       FROM workstations w JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE w.id = ANY($1::uuid[]) AND $2 = ANY (wc.capabilities)`,
    [gate.workstationIds, PR_REVIEW_CAPABILITY],
  );
  if (capable.length === 0) return { blocked: 'runner_outdated' };
  const connected = gate.workstationIds.filter((id) => capable.find((c) => c.id === id)?.connected);
  if (connected.length === 0) return { blocked: 'workstation_offline' };
  const usable = connected.find((id) => {
    const w = capable.find((c) => c.id === id);
    return opts.ignoreBusy || Number(w?.busy ?? 0) < MAX_RUNNING_PER_WORKSTATION;
  });
  return usable ? { id: usable } : { busy: true };
}

export type QueueCandidateWithGate = ReviewEligiblePr & { gate: ReviewerGate };

/** The eligible pull requests of a project, each with its repository's gate (one gate call per repository). */
export async function listQueueCandidates(
  db: Queryable,
  projectId: string,
): Promise<QueueCandidateWithGate[]> {
  const eligible = await listReviewEligiblePrs(db, projectId);
  const gates = new Map<string, ReviewerGate>();
  for (const id of new Set(eligible.map((p) => p.repoId))) gates.set(id, await reviewerGate(db, id));
  return eligible.map((p) => ({ ...p, gate: gates.get(p.repoId) ?? { state: 'not_pr_only' as const } }));
}

/**
 * The open pull requests that may get a reviewer run now: the eligible pull requests of the repositories whose gate is
 * ready, each with the workstations to send the run to. A filter over `listQueueCandidates`: a pull request on a gated
 * repository stays `not_reviewed`; the owner sees the reason on the repository and in the queue.
 */
export async function listReviewablePrs(
  db: Queryable,
  projectId: string,
): Promise<Array<ReviewEligiblePr & { workstationIds: string[] }>> {
  return (await listQueueCandidates(db, projectId)).flatMap(({ gate, ...p }) =>
    gate.state === 'ready' ? [{ ...p, workstationIds: gate.workstationIds }] : [],
  );
}
