import type { ReviewerTokenState } from '@aom/shared';
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

/**
 * The open pull requests that may get a reviewer run now: the eligible pull requests (`listReviewEligiblePrs`) of the
 * repositories whose gate is ready, each with the workstations to send the run to. THE ONLY LIST a reviewer dispatcher
 * may take work from: using `listReviewEligiblePrs` directly would start runs without a reviewer token. A pull request
 * on a gated repository stays `not_reviewed`; the owner sees the reason on the repository.
 */
export async function listReviewablePrs(
  db: Queryable,
  projectId: string,
): Promise<Array<ReviewEligiblePr & { workstationIds: string[] }>> {
  const eligible = await listReviewEligiblePrs(db, projectId);
  const gates = new Map<string, ReviewerGate>();
  for (const id of new Set(eligible.map((p) => p.repoId))) gates.set(id, await reviewerGate(db, id));
  return eligible.flatMap((p) => {
    const g = gates.get(p.repoId);
    return g?.state === 'ready' ? [{ ...p, workstationIds: g.workstationIds }] : [];
  });
}
