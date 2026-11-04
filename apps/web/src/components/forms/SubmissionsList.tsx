import { useFormSubmissions } from '../../api/queries/public-forms.ts';
import { ErrorBox, Spinner } from '../ui.tsx';

const LABEL: Record<string, string> = {
  complete: 'Received',
  failed: 'Failed, client can retry',
  receiving: 'In progress',
  storing: 'Saving',
  expired: 'Timed out',
};

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
          <li key={s.id} className="rounded-control border border-line p-3" data-testid={`submission-${s.status}`}>
            <p className="text-base font-medium text-fg">
              {LABEL[s.status] ?? s.status} · {new Date(s.createdAt).toLocaleString()}
            </p>
            <p className="text-sm text-muted">
              Version {s.formVersion}
              {s.reference ? ` · ${s.reference}` : ''}
            </p>
            {s.stored.length > 0 && (
              <ul className="mt-1 text-sm text-muted">
                {s.stored.map((p) => (
                  <li key={`${p.label}-${p.path}`} className="break-all">
                    {p.label}: {p.path}
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
