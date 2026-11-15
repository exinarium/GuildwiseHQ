import { useId, useState } from 'react';
import { usePostedFindings } from '../../api/queries/pr-reviews.ts';
import { ErrorBox } from '../ui.tsx';
import { FindingMark } from './FindingMark.tsx';

const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

/** The findings posted to a pull request, with the owner's mark on each. Collapsed; the first open loads them. */
export function PostedFindings({
  prReviewId,
  projectId,
  count,
  unmarked,
}: {
  prReviewId: string;
  projectId?: string;
  count: number;
  unmarked: number;
}) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const panel = useId();
  const q = usePostedFindings(prReviewId, asked);
  const canMarkAny = q.data?.findings.some((f) => f.canMark) ?? true;
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => {
          setAsked(true);
          setOpen((o) => !o);
        }}
        className="inline-flex min-h-11 items-center text-brand-text underline"
        data-testid={`posted-toggle-${prReviewId}`}
      >
        {open
          ? 'Hide posted findings'
          : `Show ${count} posted finding${count === 1 ? '' : 's'}${unmarked > 0 && canMarkAny ? ` (${unmarked} to mark)` : ''}`}
      </button>
      <div id={panel} hidden={!open}>
        {open &&
          (q.isPending ? (
            <p role="status">Loading the posted findings…</p>
          ) : q.isError ? (
            <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <ul className="space-y-2" aria-label="Posted findings">
              {q.data.findings.map((f) => (
                <li key={f.id} className="rounded-control border border-border p-2 text-fg">
                  <p className="break-words font-medium">
                    [{SEVERITY_LABEL[f.severity]}] {f.title}
                  </p>
                  <p className="break-words text-muted">
                    {f.path}
                    {f.line != null ? `:${f.line}` : ''}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-muted">{f.body}</p>
                  <FindingMark finding={f} projectId={projectId} />
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}
