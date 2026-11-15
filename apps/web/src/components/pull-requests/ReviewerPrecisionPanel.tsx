import { useId, useState } from 'react';
import { useReviewerPrecision } from '../../api/queries/pr-reviews.ts';
import { ErrorBox } from '../ui.tsx';

const show = (p: number | null): string => (p === null ? '–' : p.toFixed(2));

/** Useful ÷ posted per reviewer. Collapsed and fetched on request, so the counts are not in view while marking. */
export function ReviewerPrecisionPanel({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const q = useReviewerPrecision(projectId, open);
  return (
    <div className="mb-3 text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex min-h-11 items-center text-brand-text underline"
        data-testid="reviewer-precision-toggle"
      >
        {open ? 'Hide reviewer precision' : 'Reviewer precision'}
      </button>
      <div id={panel} hidden={!open}>
        {open &&
          (q.isPending ? (
            <p role="status">Loading reviewer precision…</p>
          ) : q.isError ? (
            <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
          ) : q.data.reviewers.length === 0 ? (
            <p className="text-muted">No findings posted yet.</p>
          ) : (
            <ul className="space-y-2" aria-label="Reviewer precision">
              {q.data.reviewers.map((r) => (
                <li
                  key={r.reviewer}
                  className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-control border border-border p-2 sm:grid-cols-7"
                >
                  <span className="font-medium">{r.label}</span>
                  <span className="text-muted">{r.models.join(', ') || '–'}</span>
                  <span>Posted {r.posted}</span>
                  <span>Useful {r.useful}</span>
                  <span>Noise {r.noise}</span>
                  <span>Unmarked {r.unmarked}</span>
                  <span
                    className="font-semibold"
                    title={r.precision === null ? undefined : `${Math.round(r.precision * 100)}%`}
                    data-testid={`precision-${r.reviewer}`}
                  >
                    Precision {show(r.precision)}
                  </span>
                </li>
              ))}
            </ul>
          ))}
        {open && (
          <p className="mt-1 text-xs text-muted">
            Precision = useful ÷ posted. Held-back findings are not counted. Unmarked findings count as
            posted.
          </p>
        )}
      </div>
    </div>
  );
}
