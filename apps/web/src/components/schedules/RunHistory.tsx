import type { ScheduleDto, ScheduleRunDto } from '@aom/shared';
import { CircleCheck, CircleX, Clock, Mail, Webhook } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useScheduleRuns } from '../../api/queries/schedules.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, ErrorBox, ListSkeleton, Segmented } from '../ui.tsx';

const TRIGGER_LABEL: Record<ScheduleRunDto['trigger'], string> = {
  cron: 'On schedule',
  manual: 'Run now',
  event: 'Event',
  issue: 'Labelled issue',
  test: 'Test',
};

function StatusBadge({ status }: { status: ScheduleRunDto['status'] }) {
  if (status === 'ok')
    return (
      <Badge tone="success" icon={<CircleCheck aria-hidden="true" />}>
        Done
      </Badge>
    );
  if (status === 'failed')
    return (
      <Badge tone="danger" icon={<CircleX aria-hidden="true" />}>
        Failed
      </Badge>
    );
  return (
    <Badge tone="warning" icon={<Clock aria-hidden="true" />}>
      Waiting
    </Badge>
  );
}

/**
 * The run history of a schedule, and (for webhooks and e-mail) its delivery log with every try. Refreshes every few
 * seconds while open: a delivery that is waiting for its retry changes under the reader's eyes.
 */
export function RunHistory({ schedule }: { schedule: ScheduleDto }) {
  const runs = useScheduleRuns(schedule.id);
  const hasDeliveries =
    schedule.action.kind === 'integration' && ['webhook', 'email'].includes(schedule.action.integration);
  const [view, setView] = useState<'runs' | 'deliveries'>(hasDeliveries ? 'deliveries' : 'runs');
  const list = (runs.data ?? []).filter((r) => (view === 'deliveries' ? r.delivery : true));
  return (
    <div className="mt-4 border-t border-line pt-3" data-testid="run-history">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-fg">
          {view === 'deliveries' ? 'Delivery log' : 'Run history'}
        </h3>
        {hasDeliveries && (
          <Segmented
            label="History view"
            value={view}
            onChange={setView}
            options={[
              { value: 'deliveries', label: 'Deliveries' },
              { value: 'runs', label: 'All runs' },
            ]}
          />
        )}
      </div>
      {runs.isPending && <ListSkeleton label="Loading the history" rows={2} />}
      <ErrorBox error={runs.error} onRetry={() => runs.refetch()} />
      {runs.data && list.length === 0 && (
        <p className="text-sm text-muted" data-testid="run-history-empty">
          Nothing yet.{' '}
          {schedule.trigger.kind === 'manual' ? 'Use "Run now".' : 'The first run will show here.'}
        </p>
      )}
      <ol className="flex flex-col gap-2" aria-label="Runs">
        {list.map((r) => (
          <li
            key={r.id}
            className="rounded-control border border-line bg-sunken/40 p-3"
            data-testid="run-row"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={r.status} />
              <span className="text-sm font-medium text-fg">{TRIGGER_LABEL[r.trigger]}</span>
              <span className="text-xs text-subtle">{formatDateTime(r.startedAt)}</span>
              {r.delivery && (
                <Badge
                  icon={
                    r.delivery.kind === 'webhook' ? (
                      <Webhook aria-hidden="true" />
                    ) : (
                      <Mail aria-hidden="true" />
                    )
                  }
                >
                  {r.attempts} {r.attempts === 1 ? 'try' : 'tries'}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-fg [overflow-wrap:anywhere]">{r.summary}</p>
            {r.label && <p className="text-xs text-subtle [overflow-wrap:anywhere]">{r.label}</p>}
            {r.error && (
              <p className="mt-1 text-sm text-danger [overflow-wrap:anywhere]" data-testid="run-error">
                {r.error}
              </p>
            )}
            {r.status === 'pending' && r.nextAttemptAt && (
              <p className="mt-1 text-xs text-subtle">Next try {formatDateTime(r.nextAttemptAt)}</p>
            )}
            {r.delivery && (
              <p className="mt-1 text-xs text-subtle [overflow-wrap:anywhere]">To {r.delivery.target}</p>
            )}
            {r.result?.cardIds?.length ? (
              <p className="mt-1 text-xs">
                <Link to={`/cards/${r.result.cardIds[0]}`} className="text-brand-text underline">
                  Open the card
                </Link>
                {r.result.cardIds.length > 1 ? ` (+${r.result.cardIds.length - 1})` : ''}
              </p>
            ) : null}
            {r.result?.intakeIds?.length ? (
              <p className="mt-1 text-xs">
                <Link to="/intake" className="text-brand-text underline">
                  {r.result.intakeIds.length} intake{r.result.intakeIds.length === 1 ? '' : 's'} with the BA
                </Link>
              </p>
            ) : null}
            {r.attemptLog.length > 0 && (
              <table className="mt-2 w-full text-left text-xs" aria-label="Tries">
                <thead className="text-subtle">
                  <tr>
                    <th className="py-0.5 pr-2 font-medium">Try</th>
                    <th className="py-0.5 pr-2 font-medium">When</th>
                    <th className="py-0.5 pr-2 font-medium">Result</th>
                    <th className="py-0.5 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="text-fg">
                  {r.attemptLog.map((a) => (
                    <tr key={a.attempt}>
                      <td className="py-0.5 pr-2">{a.attempt}</td>
                      <td className="py-0.5 pr-2">{formatDateTime(a.at)}</td>
                      <td className="py-0.5 pr-2">
                        {a.ok ? 'Delivered' : 'Failed'}
                        {a.httpStatus ? ` (HTTP ${a.httpStatus})` : ''}
                        {a.error && !a.ok ? `: ${a.error}` : ''}
                      </td>
                      <td className="py-0.5">{a.durationMs !== null ? `${a.durationMs} ms` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
