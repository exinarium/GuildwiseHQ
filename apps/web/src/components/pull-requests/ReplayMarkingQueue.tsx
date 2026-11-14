import { useEffect, useState } from 'react';
import { useMarkReplayFinding, useNextReplayFinding, useRecordShown } from '../../api/queries/pr-replays.ts';
import { ErrorBox } from '../ui.tsx';
import { FindingMark } from './FindingMark.tsx';

const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const HINT = 'Reviewers are shown when every finding is marked';

/** One finding at a time, no reviewer anywhere. Each finding is reported as shown once, for the effort clock. */
export function ReplayMarkingQueue({ replayId }: { replayId: string }) {
  const q = useNextReplayFinding(replayId, true);
  const mark = useMarkReplayFinding(replayId);
  const shown = useRecordShown();
  const step = q.data?.next ?? null;
  const findingId = step?.finding.id;
  // eslint-free: keyed on the finding id only, so a re-render never reports it again
  const [reported, setReported] = useState<string | null>(null);
  useEffect(() => {
    if (findingId && reported !== findingId) {
      setReported(findingId);
      shown.mutate(findingId);
    }
  }, [findingId, reported, shown]);
  if (q.isPending) return <p role="status">Loading the next finding…</p>;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  if (!step) return <p role="status">Every finding is marked.</p>;
  const f = step.finding;
  return (
    <section aria-label="Mark findings" className="space-y-2" data-testid="replay-marking">
      <p className="font-medium">
        Finding {step.position} of {step.total}
      </p>
      <p className="break-words">
        <a
          href={step.pr.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center text-brand-text underline"
        >
          #{step.pr.changeId} {step.pr.title}
        </a>
      </p>
      <div className="rounded-control border border-border p-3 text-fg">
        <p className="break-words font-medium">
          [{SEVERITY_LABEL[f.severity]}] {f.title}
        </p>
        <p className="break-words text-muted">
          {f.path}
          {f.line != null ? `:${f.line}` : ''}
        </p>
        <p className="whitespace-pre-wrap break-words text-muted">{f.body}</p>
        <FindingMark
          finding={f}
          hint={HINT}
          pending={mark.isPending}
          error={mark.isError ? mark.error : undefined}
          onMark={(m, done) => mark.mutate({ id: f.id, mark: m }, { onSuccess: done })}
        />
      </div>
    </section>
  );
}
