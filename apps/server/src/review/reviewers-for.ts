import { LIVE_REVIEWERS, type PrReviewer } from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';
import { latestRecordedReplay } from '../queries/pr-replays.ts';

/**
 * The reviewers of a new review round of a project: the live reviewers, plus the second reviewer (Opus) when the owner
 * switched it on AND a replay has been recorded. The replay is checked again here, so a flag set before the gate, a
 * projection rebuild or a deleted replay never starts the second reviewer.
 */
export async function reviewersFor(db: Queryable, projectId: string): Promise<PrReviewer[]> {
  const p = await one(db, 'SELECT pr_review_second_reviewer FROM projects WHERE id=$1', [projectId]);
  if (!p?.pr_review_second_reviewer) return [...LIVE_REVIEWERS];
  return (await latestRecordedReplay(db, projectId)) ? [...LIVE_REVIEWERS, 'second'] : [...LIVE_REVIEWERS];
}
