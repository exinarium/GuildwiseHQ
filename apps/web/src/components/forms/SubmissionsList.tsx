import { useFormSubmissions } from '../../api/queries/public-forms.ts';
import { ErrorBox, Spinner } from '../ui.tsx';

const LABEL: Record<string, string> = {
  complete: 'Received',
  failed: 'Failed, client can retry',
  receiving: 'In progress',
  storing: 'Saving',
  expired: 'Timed out',
};

/** The state of the removal of one file, as visible text (no tooltip: touch screens have no hover). */
export function cleanupSuffix(c: { state: string; error: string | null }): string {
  if (c.state === 'removed') return ' — removed';
  if (c.state === 'failed') return ` — could not be removed${c.error ? `: ${c.error}` : ''}`;
  return ` — waiting to be removed${c.error ? ` (${c.error})` : ''}`;
}

export function cleanupSummary(c: { pending: number; removed: number; failed: number }): string {
  const parts: string[] = [];
  if (c.removed) parts.push(`${c.removed} removed`);
  if (c.pending) parts.push(`${c.pending} waiting to be removed`);
  if (c.failed) parts.push(`${c.failed} could not be removed`);
  return `Uploaded files: ${parts.join(' · ')}`;
}

/** What came in: status, time, the client reference and where it was stored. No answers: those are in the firm's storage. */
export function SubmissionsList({ formId }: { formId: string }) {
  const q = useFormSubmissions(formId);
  return (
    <section aria-label="Submissions" data-testid="submissions" className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold text-fg">Submissions</h3>
      <p className="text-sm text-muted">
        Answers and files are in your own storage. This list holds only status and where they were saved.
      </p>
      {q.isPending && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      <ul className="flex flex-col gap-2">
        {q.data?.map((s) => (
          <li
            key={s.id}
            className="rounded-control border border-line p-3"
            data-testid={`submission-${s.status}`}
          >
            <p className="text-base font-medium text-fg">
              {LABEL[s.status] ?? s.status} · {new Date(s.createdAt).toLocaleString()}
            </p>
            <p className="text-sm text-muted">
              Version {s.formVersion}
              {s.reference ? ` · ${s.reference}` : ''}
            </p>
            {s.cleanup && (s.cleanup.pending > 0 || s.cleanup.removed > 0 || s.cleanup.failed > 0) && (
              <p className="text-sm text-fg" data-testid="submission-cleanup">
                {cleanupSummary(s.cleanup)}
              </p>
            )}
            {s.stored.length > 0 && (
              <ul className="mt-1 text-sm text-muted">
                {s.stored.map((p) => (
                  <li key={`${p.label}-${p.path}`} className="break-all">
                    {p.label}: {p.path}
                    {p.cleanup && (
                      <span data-testid={`stored-cleanup-${p.cleanup.state}`}>
                        {cleanupSuffix(p.cleanup)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {q.data?.length === 0 && <li className="text-sm text-muted">Nothing has been submitted yet.</li>}
      </ul>
    </section>
  );
}
