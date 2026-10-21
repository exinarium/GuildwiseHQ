import { Link } from 'react-router';
import { useDeployRuns } from '../../api/queries/delivery.ts';
import { Badge } from '../ui.tsx';
import { agoText } from './model.ts';
import { Section } from './Section.tsx';

const RESULT: Record<string, { text: string; tone: 'green' | 'red' | 'amber' | 'blue' | 'neutral' }> = {
  succeeded: { text: 'Worked', tone: 'green' },
  failed: { text: 'Failed', tone: 'red' },
  refused: { text: 'Refused', tone: 'red' },
  running: { text: 'Updating', tone: 'blue' },
  queued: { text: 'Waiting', tone: 'blue' },
  requested: { text: 'Asked', tone: 'neutral' },
  waiting_release: { text: 'Waiting for a release', tone: 'amber' },
  cancelled: { text: 'Cancelled', tone: 'neutral' },
};

/** The last updates of this project, newest first, with a link to the whole history in Releases. */
export function HistorySection({
  projectId,
  labelOf,
}: {
  projectId: string;
  labelOf: (env: string) => string;
}) {
  const runs = useDeployRuns();
  const mine = (runs.data ?? []).filter((r) => r.projectId === projectId && !r.dryRun).slice(0, 10);
  return (
    <Section
      id="history"
      title="History"
      sub="The last updates of all environments."
      collapsible
      actions={
        <Link
          to="/releases?tab=history"
          className="inline-flex min-h-9 items-center text-sm font-medium text-brand hover:underline"
        >
          See all in Releases
        </Link>
      }
    >
      {runs.isError ? (
        <p className="text-sm text-muted">The history is not available to you here. Ask the project owner.</p>
      ) : mine.length === 0 ? (
        <p className="text-sm text-muted" data-testid="history-empty">
          Nothing has been updated yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line" data-testid="history-list">
          {mine.map((r) => {
            const res = RESULT[r.status] ?? RESULT.requested;
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="font-medium text-fg">{labelOf(r.env)}</span>
                <Badge tone={res?.tone ?? 'neutral'}>{res?.text ?? r.status}</Badge>
                {r.trigger === 'rollback' && <Badge>Rollback</Badge>}
                <span className="tnum text-muted">{(r.deployedCommit ?? r.commit)?.slice(0, 7) ?? ''}</span>
                <span className="ml-auto text-xs text-subtle">{agoText(r.finishedAt ?? r.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
