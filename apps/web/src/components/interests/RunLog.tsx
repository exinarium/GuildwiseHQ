import type { InterestRunDto } from '@aom/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useInterestDeliveries, useInterestRun, useInterestRuns } from '../../api/queries/interests.ts';
import { RUN_STATUS_LABEL, runStatusTone } from '../../lib/interests.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, EmptyState, ErrorBox, ListSkeleton, Panel, Spinner } from '../ui.tsx';

const TRIGGER_LABEL: Record<InterestRunDto['trigger'], string> = {
  cron: 'schedule',
  manual: 'by hand',
  after_scan: 'after a scan',
  migrated: 'migrated',
};

const duration = (r: InterestRunDto): string => {
  if (!r.finishedAt) return '';
  const s = Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

/** The run log: every scan and research run with what it found and published, the ratings, the items and the agents. */
export function RunLog({ interestId }: { interestId: string }) {
  const [limit, setLimit] = useState(20);
  const runs = useInterestRuns(interestId, limit);
  const [open, setOpen] = useState<string | null>(null);
  const deliveries = useInterestDeliveries(interestId);
  return (
    <div className="flex flex-col gap-4" data-testid="run-log">
      {runs.isPending && <ListSkeleton label="Loading the run log" rows={3} />}
      <ErrorBox error={runs.error} onRetry={() => runs.refetch()} />
      {runs.data && runs.data.runs.length === 0 && (
        <EmptyState title="No runs yet" description="Press Run scan, or wait for the run schedule." />
      )}
      <ul className="flex flex-col gap-2" aria-label="Runs">
        {runs.data?.runs.map((r) => (
          <li key={r.id} data-testid={`run-${r.card.ref}`}>
            <RunRow
              run={r}
              interestId={interestId}
              expanded={open === r.id}
              onToggle={() => setOpen(open === r.id ? null : r.id)}
            />
          </li>
        ))}
      </ul>
      {runs.data?.hasMore && (
        <div className="flex justify-center">
          <Button data-testid="run-log-more" onClick={() => setLimit(limit + 20)}>
            Load older runs
          </Button>
        </div>
      )}
      {(deliveries.data?.deliveries.length ?? 0) > 0 && (
        <Panel title="Deliveries" data-testid="delivery-log">
          <ul className="flex flex-col gap-1 text-sm">
            {deliveries.data?.deliveries.map((d) => (
              <li key={d.id}>
                {formatDateTime(d.at)}: {d.itemCount} {d.itemCount === 1 ? 'item' : 'items'} on your desk
                {d.heldBack > 0 && `, ${d.heldBack} held back by the quiet cap`}
                {d.trigger === 'manual' && ' (delivered by hand)'}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

function RunRow({
  run: r,
  interestId,
  expanded,
  onToggle,
}: {
  run: InterestRunDto;
  interestId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const rated = r.ratings.useful + r.ratings.irrelevant + r.ratings.boring;
  return (
    <Panel padding="none">
      <button
        type="button"
        aria-expanded={expanded}
        data-testid="run-toggle"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-card px-3 py-3 text-left hover:bg-sunken [@media(pointer:coarse)]:min-h-11"
      >
        <Chevron aria-hidden="true" className="size-4 shrink-0 text-subtle" />
        <span className="text-sm font-medium text-fg">{formatDateTime(r.startedAt)}</span>
        <span className="text-sm text-muted">
          {r.kind === 'research' ? 'Research' : 'Scan'} · {TRIGGER_LABEL[r.trigger]}
          {r.startedBy ? ` (${r.startedBy.name})` : ''}
        </span>
        <Badge tone={runStatusTone(r.status)}>{RUN_STATUS_LABEL[r.status]}</Badge>
        {r.kind === 'scan' && (
          <span className="text-sm text-fg" data-testid="run-counts">
            {r.found != null ? `found ${r.found}` : 'found ?'} → {r.published ?? 0} published
            {(r.duplicatesDropped || r.overMaxDropped) &&
              ` (${[
                r.duplicatesDropped ? `dup ${r.duplicatesDropped}` : '',
                r.overMaxDropped ? `over max ${r.overMaxDropped}` : '',
              ]
                .filter(Boolean)
                .join(', ')})`}
          </span>
        )}
        <span className="ml-auto text-xs text-subtle">
          {r.card.ref}
          {duration(r) && ` · ${duration(r)}`}
        </span>
      </button>
      {r.kind === 'scan' && r.published != null && r.published > 0 && (
        <p className="px-3 pb-2 pl-10 text-xs text-muted" data-testid="run-ratings">
          Ratings: useful {r.ratings.useful} · irrelevant {r.ratings.irrelevant} · boring {r.ratings.boring} ·
          unrated {r.ratings.unrated}
          {rated === 0 && r.ratings.unrated === 0 && ' (waiting for delivery)'}
        </p>
      )}
      {expanded && <RunDetail interestId={interestId} run={r} />}
    </Panel>
  );
}

function RunDetail({ interestId, run }: { interestId: string; run: InterestRunDto }) {
  const d = useInterestRun(interestId, run.id);
  if (d.isPending) return <Spinner />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const { items, notes, shifts } = d.data;
  return (
    <div
      className="flex flex-col gap-3 border-t border-line px-3 py-3 pl-10 text-sm"
      data-testid="run-detail"
    >
      {items.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold text-subtle">Items</h3>
          <ol className="flex flex-col gap-1.5">
            {items.map((i, n) => (
              <li key={i.id} data-testid="run-item">
                <span className="text-subtle">{n + 1}.</span> <Badge tone="blue">{i.kind}</Badge>{' '}
                <a
                  href={i.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-brand-text hover:underline"
                >
                  {i.title}
                </a>{' '}
                <span className="text-subtle">· {i.source}</span>
                {i.verdict && <Badge tone={i.verdict === 'useful' ? 'green' : 'amber'}>{i.verdict}</Badge>}
                {!i.delivered && <Badge tone="neutral">waiting for delivery</Badge>}
                {i.transcript && (
                  <span className="ml-1 text-xs text-subtle">
                    transcript:{' '}
                    {i.transcript.status === 'ok'
                      ? `${i.transcript.chars ?? '?'} characters`
                      : i.transcript.status === 'none'
                        ? 'none available'
                        : i.transcript.status}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {notes.length > 0 && (
        <div>
          <h3 className="mb-1 text-xs font-semibold text-subtle">Notes</h3>
          <ul>
            {notes.map((n) => (
              <li key={n.id}>
                <Link to={`/cards/${n.cardRef}`} className="underline">
                  {n.title}
                </Link>
                {n.vaultPath && <span className="text-xs text-subtle"> · {n.vaultPath}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-xs font-semibold text-subtle">Agents</h3>
        {shifts.length === 0 ? (
          <p className="text-subtle">No agent has worked on it yet.</p>
        ) : (
          <ul data-testid="run-shifts">
            {shifts.map((s) => (
              <li key={s.id}>
                {s.agentName ?? 'An agent'}
                {s.role && ` (${s.role})`}: {s.status}
                {s.startedAt && ` · ${formatDateTime(s.startedAt)}`}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1">
          <Link to={`/cards/${run.card.ref}`} className="underline">
            Open {run.card.ref} for the shift logs
          </Link>
        </p>
      </div>
      {run.parentRunId && <p className="text-xs text-subtle">Started by an earlier scan.</p>}
    </div>
  );
}
