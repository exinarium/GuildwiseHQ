import { useId, useState } from 'react';
import { useHeldBackFindings } from '../../api/queries/pr-reviews.ts';
import { Badge, ErrorBox } from '../ui.tsx';

const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

/**
 * The findings the cap kept off the pull request. Collapsed; the first open loads them. A real button (tap, keyboard and
 * screen reader), nothing that needs hover or typing.
 */
export function HeldBackFindings({ prReviewId, count }: { prReviewId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(false);
  const panel = useId();
  const q = useHeldBackFindings(prReviewId, asked);
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
        data-testid={`held-back-toggle-${prReviewId}`}
      >
        {open ? 'Hide held-back findings' : `Show ${count} held-back finding${count === 1 ? '' : 's'}`}
      </button>
      <div id={panel} hidden={!open}>
        {open &&
          (q.isPending ? (
            <p role="status">Loading the held-back findings…</p>
          ) : q.isError ? (
            <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
          ) : (
            <ul className="space-y-2" aria-label="Held-back findings">
              {q.data.findings.map((f) => (
                <li key={f.id} className="rounded-control border border-border p-2 text-fg">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">Held back: not posted to the PR</Badge>
                    {f.rank != null && <span>#{f.rank}</span>}
                    <span>Severity: {SEVERITY_LABEL[f.severity]}</span>
                  </p>
                  <p className="break-words text-muted">
                    {f.path}
                    {f.line != null ? `:${f.line}` : ''}
                  </p>
                  <p className="break-words font-medium">{f.title}</p>
                  <p className="whitespace-pre-wrap break-words text-muted">{f.body}</p>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}
