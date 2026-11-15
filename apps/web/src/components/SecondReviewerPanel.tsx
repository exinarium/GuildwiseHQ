import type { ProjectDetailResponse } from '@aom/shared';
import { Link } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useSetSecondReviewer } from '../api/queries/pr-reviews.ts';
import { Callout, ErrorBox, Panel } from './ui.tsx';

const pct = (v: number | null | undefined): string => (v == null ? 'no data' : v.toFixed(2));

/**
 * "Second reviewer (Opus)": every pull request of a PR-only repository is also reviewed by the deeper model, and the
 * findings of both are combined before they are posted. It can only be switched on once a 20-PR replay has measured both
 * reviewers. Only the project owner changes it. There is no text field: nothing opens the soft keyboard.
 */
export function SecondReviewerPanel({
  projectId,
  projectKey,
  project,
  canChange,
}: {
  projectId: string;
  projectKey: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const set = useSetSecondReviewer(projectId);
  const sr = project.secondReviewer;
  const enabled = sr?.enabled === true;
  const recorded = Boolean(sr?.replayId);
  // switching off is always possible; switching on needs a recorded replay
  const disabled = !canChange || set.isPending || (!enabled && !recorded);
  const raced = set.error instanceof ApiError && set.error.code === 'replay_required';

  return (
    <Panel title="Second reviewer (Opus)" data-testid="second-reviewer-panel">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Each pull request on a PR-only repository is reviewed by both reviewers. Their findings are combined
          before posting, and duplicates are posted once. It roughly doubles model spend per reviewed pull
          request; the daily limit still counts pull requests, so a pair is one review.
        </p>
        {!recorded && (
          <Callout tone="info" role="status" data-testid="second-reviewer-replay-required">
            <span>
              Record a 20-PR replay first. It measures both reviewers offline so you can compare them before
              the second reviewer comments on live pull requests.{' '}
              <Link
                to={`/p/${projectKey}/pull-requests/replay`}
                className="inline-flex min-h-11 items-center text-brand-text underline"
              >
                Go to the replay
              </Link>
            </span>
          </Callout>
        )}
        {recorded && sr && (
          <p className="text-sm text-subtle" data-testid="second-reviewer-replay">
            Replay recorded {sr.replayRecordedAt ? new Date(sr.replayRecordedAt).toLocaleDateString() : ''}
            {sr.precision && ` · Sonnet ${pct(sr.precision.first)} · Opus ${pct(sr.precision.second)}`}
          </p>
        )}
        {!canChange && (
          <p className="text-sm text-subtle" data-testid="second-reviewer-readonly">
            The second reviewer is {enabled ? 'on' : 'off'}. Only the project owner changes this.
          </p>
        )}
        <label className="flex min-h-11 items-center gap-3 py-2">
          <input
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            className="size-5"
            checked={enabled}
            disabled={disabled}
            data-testid="second-reviewer-switch"
            onChange={(e) => set.mutate(e.target.checked)}
          />
          <span className="text-sm font-medium text-fg">Review with the second reviewer (Opus)</span>
        </label>
        {raced && (
          <Callout tone="warning" role="alert" data-testid="second-reviewer-race">
            The replay is no longer recorded. Record a 20-PR replay first.
          </Callout>
        )}
        {!raced && <ErrorBox error={set.error} />}
      </div>
    </Panel>
  );
}
