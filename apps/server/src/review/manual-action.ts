import type { PrReviewRunState, PrReviewState } from '@aom/shared';

export type ManualActionInput = {
  reviewState: PrReviewState;
  closed: boolean;
  prOnly: boolean;
  /** The latest first-reviewer run by start time. */
  lastRun: { id: string; state: PrReviewRunState } | null;
};

export type ManualAction =
  | { kind: 'review_now' | 'rerun'; previousRunId: string | null }
  | { refused: 'closed' | 'not_eligible' | 'running' };

/**
 * What the owner may start by hand on a pull request. One rule for the trigger and for the button, so they agree.
 * A re-run is offered only when the latest run timed out, and it always points at that run.
 */
export function manualReviewAction(i: ManualActionInput): ManualAction {
  if (i.closed) return { refused: 'closed' };
  if (!i.prOnly || i.reviewState !== 'not_reviewed') return { refused: 'not_eligible' };
  const last = i.lastRun;
  if (last && (last.state === 'running' || last.state === 'completed')) return { refused: 'running' };
  if (last && last.state === 'timed_out') return { kind: 'rerun', previousRunId: last.id };
  return { kind: 'review_now', previousRunId: null };
}
