import type { PrReviewDto } from '@aom/shared';
import { useState } from 'react';
import { useTriggerPrReview } from '../../api/queries/pr-reviews.ts';
import { Button, ConfirmDialog, ErrorBox } from '../ui.tsx';

/**
 * The owner's by-hand review on a pull request that is not waiting in the queue (after a timeout or a failure).
 * The server decides what is offered (`manualAction`); a tap opens a confirmation because it adds spend.
 */
export function PrReviewTriggerButton({ pr, projectId }: { pr: PrReviewDto; projectId: string }) {
  const trigger = useTriggerPrReview(projectId);
  const [open, setOpen] = useState(false);
  const action = pr.manualAction;
  if (!action || pr.queueSlot) return null;
  const rerun = action.kind === 'rerun';
  const label = rerun ? 'Re-run review' : 'Review now';
  return (
    <div className="space-y-2">
      <Button
        className="min-h-11 w-full sm:w-auto"
        disabled={trigger.isPending}
        onClick={() => setOpen(true)}
        data-testid={`pr-review-trigger-${pr.changeId}`}
      >
        {label}
      </Button>
      <ErrorBox error={trigger.error} />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`${label}?`}
        description={`${
          rerun ? 'The last run timed out after 10 minutes. A re-run starts a new review now. ' : ''
        }This review is not counted toward the daily cap and adds to today's spend.`}
        confirmLabel={label}
        pending={trigger.isPending}
        onConfirm={() => {
          if (trigger.isPending) return;
          trigger.mutate(
            { prReviewId: pr.id, previousRunId: action.previousRunId ?? undefined },
            { onSettled: () => setOpen(false) },
          );
        }}
      />
    </div>
  );
}
