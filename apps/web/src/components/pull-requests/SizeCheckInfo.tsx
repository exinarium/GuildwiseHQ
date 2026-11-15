import { type PrReviewDto, sizeUnitWord } from '@aom/shared';

const when = (iso: string): string => new Date(iso).toLocaleString();

const chainText = (pr: PrReviewDto): string => {
  const others = (pr.split?.members ?? []).filter((m) => m.changeId !== pr.changeId);
  return others.length > 0 ? ` (stacked with ${others.map((m) => `#${m.changeId}`).join(', ')})` : '';
};

/** The author notice of a pull request sent back: told, being told, or not told and why. Text only. */
function NoticeLine({ pr }: { pr: PrReviewDto }) {
  const n = pr.split?.notice ?? null;
  let text = 'Notifying the author…';
  if (n?.state === 'posted') text = `Author notified${n.postedAt ? ` ${when(n.postedAt)}` : ''}`;
  else if (n?.state === 'failed') text = `Author not notified${n.error ? `: ${n.error}` : ''}`;
  return (
    <p data-testid={`pr-split-notice-${pr.changeId}`}>
      {text}
      {n?.state === 'posted' && n.url && (
        <>
          {' · '}
          <a
            href={n.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center text-brand-text hover:underline"
          >
            View
          </a>
        </>
      )}
    </p>
  );
}

/**
 * What the size check says about a pull request, in words: sent back to its author to split (no owner action), the
 * "timed out twice" decision that waits for the owner, and the size where known. No hover-only information, no input.
 */
export function SizeCheckInfo({ pr }: { pr: PrReviewDto }) {
  const size = pr.size ?? null;
  const split = pr.state === 'needs_split' ? pr.split : null;
  return (
    <div className="space-y-1" data-testid={`pr-size-${pr.changeId}`}>
      {pr.state === 'size_exception_pending' && pr.sizeException && (
        <p data-testid={`pr-size-exception-pending-${pr.changeId}`}>
          Size exception pending: the owner answers by {new Date(pr.sizeException.dueAt).toLocaleDateString()}
          .
          {size?.state === 'over' && size.unit
            ? ` ${size.total} of ${size.budget} ${sizeUnitWord(size.unit)}.`
            : ''}
        </p>
      )}
      {pr.state !== 'size_exception_pending' && pr.sizeException?.state === 'approved' && size?.unit && (
        <p data-testid={`pr-size-exception-approved-${pr.changeId}`}>
          Over budget, approved exception (up to {pr.sizeException.size} {sizeUnitWord(size.unit)}).
        </p>
      )}
      {split && (
        <>
          <p data-testid={`pr-split-detail-${pr.changeId}`}>
            Over the size budget: {split.total ?? '?'} of {split.budget ?? '?'}{' '}
            {split.unit ? sizeUnitWord(split.unit) : 'changed lines'}
            {chainText(pr)}. Sent back to the author to split.
            {split.reason === 'size_exception_rejected' && ' Size exception not approved.'}
            {split.reason === 'size_exception_lapsed' &&
              ' Size exception lapsed: no answer in 2 working days.'}
          </p>
          <NoticeLine pr={pr} />
        </>
      )}
      {pr.attention === 'timed_out_twice' && (
        <p data-testid={`pr-timed-out-twice-${pr.changeId}`}>
          Timed out twice. It is within the size budget, so it waits for your decision: re-run the review or
          leave it.
          {pr.reminder
            ? pr.reminder.remindedAt
              ? ` Reminder sent ${when(pr.reminder.remindedAt)}.`
              : ` Reminder ${when(pr.reminder.dueAt)}.`
            : ''}
        </p>
      )}
      {!split && size?.state === 'within' && size.total !== undefined && size.unit && (
        <p data-testid={`pr-size-line-${pr.changeId}`}>
          Size {size.total} of {size.budget} {sizeUnitWord(size.unit)}
          {size.complete === false ? ' (the list of open pull requests is incomplete)' : ''}
        </p>
      )}
      {!split && size?.state === 'inactive' && (
        <p data-testid={`pr-size-line-${pr.changeId}`}>Size check inactive: no size budget set</p>
      )}
      {!split && size?.state === 'unknown' && size.reason === 'no_size' && (
        <p data-testid={`pr-size-line-${pr.changeId}`}>Size unknown (update the runner on the workstation)</p>
      )}
    </div>
  );
}
