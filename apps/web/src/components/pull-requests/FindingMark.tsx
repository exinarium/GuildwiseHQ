import type { FindingMark as Mark, PostedFindingDto } from '@aom/shared';
import { useState } from 'react';
import { useMarkFinding } from '../../api/queries/pr-reviews.ts';
import { Badge, ErrorBox } from '../ui.tsx';

const MARKS: Array<{ mark: Mark; label: string }> = [
  { mark: 'useful', label: 'Useful' },
  { mark: 'noise', label: 'Noise' },
];

/**
 * The owner's one-tap mark on a posted finding. Two big buttons, no text field (so no soft keyboard), nothing that needs
 * hover. The reviewer is shown only after the mark, from the server's answer (no optimistic update).
 */
export function FindingMark({
  finding,
  projectId,
  onMark,
  pending,
  error,
  hint,
}: {
  finding: PostedFindingDto;
  projectId?: string;
  /** The 20-PR replay marks through its own mutation. Absent: the live `useMarkFinding(projectId)`. */
  onMark?: (mark: Mark, done: () => void) => void;
  pending?: boolean;
  error?: unknown;
  /** Replaces "Reviewer shown after you mark". */
  hint?: string;
}) {
  const live = useMarkFinding(projectId);
  const [changing, setChanging] = useState(false);
  const marked = finding.mark !== null;
  const isPending = onMark ? !!pending : live.isPending;
  const err = onMark ? error : live.error;
  const choose = (mark: Mark) =>
    onMark
      ? onMark(mark, () => setChanging(false))
      : live.mutate({ id: finding.id, mark }, { onSuccess: () => setChanging(false) });
  const buttons = (
    <fieldset className="grid grid-cols-2 gap-2" disabled={isPending}>
      <legend className="sr-only">Mark finding: {finding.title}</legend>
      {MARKS.map((m) => (
        <button
          key={m.mark}
          type="button"
          aria-pressed={marked ? finding.mark === m.mark : undefined}
          onClick={() => choose(m.mark)}
          className="inline-flex min-h-11 items-center justify-center rounded-control border border-border px-3 font-medium text-fg hover:bg-surface aria-pressed:border-brand-text aria-pressed:font-semibold disabled:opacity-60"
          data-testid={`mark-${m.mark}-${finding.id}`}
        >
          {m.label}
        </button>
      ))}
    </fieldset>
  );
  return (
    <div className="mt-2 space-y-2" data-testid={`finding-mark-${finding.id}`}>
      {marked && !changing ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge tone={finding.mark === 'useful' ? 'green' : 'neutral'}>
            {finding.mark === 'useful' ? 'Useful' : 'Noise'}
          </Badge>
          {finding.markedAt && (
            <span className="text-muted">marked {new Date(finding.markedAt).toLocaleString()}</span>
          )}
          {finding.reviewers && finding.reviewers.length > 0 && (
            <span className="text-muted" data-testid={`finding-reviewer-${finding.id}`}>
              Reviewer:{' '}
              {finding.reviewers.map((r) => (r.model ? `${r.label} · ${r.model}` : r.label)).join(', ')}
            </span>
          )}
          {finding.canMark && (
            <button
              type="button"
              onClick={() => setChanging(true)}
              className="inline-flex min-h-11 items-center px-2 text-brand-text underline"
            >
              Change
            </button>
          )}
        </div>
      ) : finding.canMark ? (
        <>
          {buttons}
          {!marked && <p className="text-muted">{hint ?? 'Reviewer shown after you mark'}</p>}
        </>
      ) : (
        <p className="text-muted">Not marked yet</p>
      )}
      {err != null && <ErrorBox error={err} />}
    </div>
  );
}
