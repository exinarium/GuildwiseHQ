import { type DeskItemDto, type SizeUnit, sizeUnitWord } from '@aom/shared';
import { useState } from 'react';
import { useResolveDeskItem } from '../../api/queries/desk.ts';
import { Button, ErrorBox, TextArea, useToast } from '../ui.tsx';

type Data = {
  reason?: string;
  size?: number;
  budget?: number;
  unit?: SizeUnit;
  url?: string;
  dueAt?: string;
};

/** "1,240 of 800 changed lines, 155%" */
export function sizeAgainstBudget(d: Data): string | null {
  if (typeof d.size !== 'number' || typeof d.budget !== 'number' || !d.unit) return null;
  const pct = d.budget > 0 ? `, ${Math.round((d.size / d.budget) * 100)}%` : '';
  return `${d.size.toLocaleString('en-US')} of ${d.budget.toLocaleString('en-US')} ${sizeUnitWord(d.unit)}${pct}`;
}

/**
 * A size exception request on the owner's desk: the reason, the size against the budget, and Approve or Reject. There is
 * no Dismiss and no Snooze: it is answered, or it lapses after 2 working days and goes back to the author (no reminder).
 * Buttons are 44 px tall, and the note field scrolls into view when focused so the soft keyboard does not cover it.
 */
export function SizeExceptionDeskItem({ item }: { item: DeskItemDto }) {
  const data = (item.data ?? {}) as Data;
  const resolve = useResolveDeskItem();
  const toast = useToast();
  const [note, setNote] = useState('');
  const size = sizeAgainstBudget(data);
  const decide = (resolution: 'approved' | 'rejected') =>
    resolve.mutate(
      { id: item.id, body: { resolution, ...(note.trim() ? { note: note.trim() } : {}) } },
      {
        onSuccess: () =>
          toast.success(resolution === 'approved' ? 'Approved: the PR stays as one' : 'Rejected: sent back'),
        onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save your answer'),
      },
    );
  return (
    <div className="mt-3 space-y-3" data-testid="size-exception-item">
      {size && (
        <p className="text-sm font-medium text-fg" data-testid="size-exception-size">
          {size}
        </p>
      )}
      {data.reason && (
        <div>
          <p className="text-xs font-medium text-subtle">Reason</p>
          <p className="whitespace-pre-wrap text-base text-muted" data-testid="size-exception-reason">
            {data.reason}
          </p>
        </div>
      )}
      {data.url && (
        <a
          href={data.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center text-brand-text hover:underline"
        >
          Open the pull request
        </a>
      )}
      {data.dueAt && (
        <p className="text-sm text-subtle" data-testid="size-exception-due">
          Answer by {new Date(data.dueAt).toLocaleDateString()}. If you do not, it goes back to the author to
          split. You will not be reminded.
        </p>
      )}
      <TextArea
        label="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onFocus={(e) => e.currentTarget.scrollIntoView?.({ block: 'center', behavior: 'smooth' })}
        maxLength={2000}
      />
      <ErrorBox error={resolve.error} />
      <div className="sticky-actions gap-2 max-sm:grid max-sm:grid-cols-2 sm:flex sm:flex-row [&>button]:min-h-11 [&>button]:max-sm:w-full">
        <Button
          data-testid="size-exception-reject"
          disabled={resolve.isPending}
          onClick={() => decide('rejected')}
        >
          Reject
        </Button>
        <Button
          variant="primary"
          data-testid="size-exception-approve"
          loading={resolve.isPending}
          onClick={() => decide('approved')}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}
