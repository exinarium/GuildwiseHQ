import { SIZE_EXCEPTION_STATES, type SizeExceptionState, sizeUnitWord } from '@aom/shared';
import { useState } from 'react';
import { useSizeExceptions } from '../../api/queries/pr-reviews.ts';
import { Badge, ErrorBox } from '../ui.tsx';

const LABEL: Record<SizeExceptionState, string> = {
  pending: 'Waiting for the owner',
  approved: 'Approved',
  rejected: 'Rejected',
  lapsed: 'Lapsed (no answer)',
  withdrawn: 'Withdrawn (PR closed)',
  superseded: 'Approved, then the PR grew',
};
const TONE: Record<SizeExceptionState, 'green' | 'amber' | 'neutral'> = {
  pending: 'amber',
  approved: 'green',
  rejected: 'neutral',
  lapsed: 'neutral',
  withdrawn: 'neutral',
  superseded: 'neutral',
};
const when = (iso: string): string => new Date(iso).toLocaleDateString();

/** The size exception requests of the project with the reason and the outcome, so the owner can review what was accepted. */
export function SizeExceptionHistory({ projectId }: { projectId: string }) {
  const [state, setState] = useState<SizeExceptionState | ''>('');
  const q = useSizeExceptions(projectId, state || undefined);
  const list = q.data?.sizeExceptions ?? [];
  if (q.isSuccess && list.length === 0 && !state) return null;
  return (
    <section className="mb-4" aria-label="Size exceptions" data-testid="size-exception-history">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-fg">Size exceptions</h2>
        <label className="ml-auto inline-flex min-h-11 items-center gap-2 text-sm text-muted">
          Show
          <select
            className="min-h-11 rounded-md border border-border bg-surface px-2 text-base"
            value={state}
            onChange={(e) => setState(e.target.value as SizeExceptionState | '')}
            data-testid="size-exception-filter"
          >
            <option value="">All</option>
            {SIZE_EXCEPTION_STATES.map((s) => (
              <option key={s} value={s}>
                {LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {q.isError && <ErrorBox error={q.error} onRetry={() => void q.refetch()} />}
      <ul className="mt-2 space-y-2">
        {list.map((e) => (
          <li
            key={e.id}
            className="rounded-md border border-border p-3 text-sm"
            data-testid={`size-exception-${e.id}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={TONE[e.state]}>{LABEL[e.state]}</Badge>
              <a
                href={e.prUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center font-medium text-brand-text hover:underline"
              >
                #{e.changeId} {e.repoName}
              </a>
              <span className="text-muted">
                {e.size} of {e.budget} {sizeUnitWord(e.unit)}
              </span>
              <span className="text-xs text-subtle">asked {when(e.requestedAt)}</span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-muted">{e.reason}</p>
            {e.note && <p className="mt-1 text-xs text-subtle">Owner's note: {e.note}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
