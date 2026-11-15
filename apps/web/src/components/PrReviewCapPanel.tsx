import {
  PR_REVIEW_DAILY_CAP_DEFAULT,
  PR_REVIEW_DAILY_CAP_MAX,
  type ProjectDetailResponse,
} from '@aom/shared';
import { useState } from 'react';
import { useSetPrReviewCap } from '../api/queries/pr-reviews.ts';
import { Badge, Button, ErrorBox, Panel, TextInput } from './ui.tsx';

/**
 * "Daily automatic reviews": how many pull requests of PR-only repositories are reviewed automatically each day. The
 * rest wait in the queue. Only the project owner changes it; reviews the owner starts by hand are not counted.
 */
export function PrReviewCapPanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const set = useSetPrReviewCap(projectId);
  const cap = project.prReviewDailyCap ?? PR_REVIEW_DAILY_CAP_DEFAULT;
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? String(cap);
  const parsed = Number(text);
  const valid =
    text.trim() !== '' && Number.isInteger(parsed) && parsed >= 1 && parsed <= PR_REVIEW_DAILY_CAP_MAX;
  const dirty = valid && parsed !== cap;

  return (
    <Panel>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-fg">
        Daily automatic reviews
        <Badge tone="brand">
          <span data-testid="pr-review-cap-state">{cap} per day</span>
        </Badge>
      </h2>
      <p className="text-sm text-muted">
        At most this many pull requests are reviewed automatically each day (midnight to midnight in your time
        zone). The rest wait in the queue, oldest first. Reviews you start by hand are not counted.
      </p>
      <form
        aria-label="Daily automatic reviews"
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && canChange) set.mutate(parsed, { onSuccess: () => setDraft(null) });
        }}
      >
        <div className="w-40">
          <TextInput
            label="Reviews per day"
            type="number"
            inputMode="numeric"
            min={1}
            max={PR_REVIEW_DAILY_CAP_MAX}
            value={text}
            disabled={!canChange}
            onChange={(e) => setDraft(e.target.value)}
            error={!valid ? `Enter a whole number from 1 to ${PR_REVIEW_DAILY_CAP_MAX}` : undefined}
            data-testid="pr-review-cap-input"
          />
        </div>
        {canChange && (
          <Button
            type="submit"
            variant="primary"
            disabled={!dirty || set.isPending}
            data-testid="pr-review-cap-save"
          >
            Save
          </Button>
        )}
      </form>
      {!canChange && <p className="mt-2 text-sm text-muted">Only the project owner can change this.</p>}
      <ErrorBox error={set.error} />
    </Panel>
  );
}
