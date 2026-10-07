import type { InterestDto } from '@aom/shared';
import { Link } from 'react-router';
import { usePatchInterest, useRunInterest } from '../../api/queries/interests.ts';
import {
  compactRatings,
  describeDelivery,
  describeRatings,
  describeScan,
  RUN_STATUS_LABEL,
} from '../../lib/interests.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, ButtonLink, ErrorBox, Panel, useToast } from '../ui.tsx';

/** The active tick: a labelled switch that pauses and resumes the interest. */
export function ActiveTick({
  interest: i,
  size = 'md',
}: {
  interest: Pick<InterestDto, 'id' | 'name' | 'status' | 'canManage' | 'archived'>;
  size?: 'md' | 'lg';
}) {
  const patch = usePatchInterest();
  const toast = useToast();
  const on = i.status === 'active';
  return (
    <label
      className={`inline-flex items-center gap-2 text-sm font-medium ${i.canManage && !i.archived ? 'cursor-pointer' : 'cursor-default opacity-80'} ${size === 'lg' ? 'min-h-11' : 'min-h-9 [@media(pointer:coarse)]:min-h-11'}`}
    >
      <input
        type="checkbox"
        className="size-4 accent-[var(--brand)]"
        checked={on}
        disabled={!i.canManage || i.archived || patch.isPending}
        aria-label={`${on ? 'Pause' : 'Resume'} ${i.name}`}
        data-testid="interest-toggle"
        onChange={() =>
          patch.mutate(
            { id: i.id, body: { status: on ? 'paused' : 'active' } },
            { onSuccess: () => toast.success(on ? `${i.name} paused` : `${i.name} resumed`) },
          )
        }
      />
      {on ? 'Active' : 'Paused'}
    </label>
  );
}

/** One interest in the list: tick, cadence, last run, delivery, and the quick actions. */
export function InterestCard({ interest: i, onResearch }: { interest: InterestDto; onResearch: () => void }) {
  const run = useRunInterest();
  const toast = useToast();
  const s = i.stats;
  const last = s.lastRun;
  const agents = [
    i.agents.scout && `Scout: ${i.agents.scout.name}`,
    i.agents.curator && `Curator: ${i.agents.curator.name}`,
    i.agents.researcher && `Researcher: ${i.agents.researcher.name}`,
  ].filter(Boolean);
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ActiveTick interest={i} />
        <h2 className="min-w-0 text-lg font-semibold [overflow-wrap:anywhere] text-fg">
          <Link to={`/interests/${i.id}`} className="hover:underline" data-testid="interest-open">
            {i.name}
          </Link>
        </h2>
        {i.archived && <Badge tone="neutral">Archived</Badge>}
        {s.failing && (
          <Badge tone="red" title={s.lastError ?? undefined}>
            Cannot run ({s.failCount} {s.failCount === 1 ? 'try' : 'tries'})
          </Badge>
        )}
        {s.items.held > 0 && (
          <Badge tone="blue" title="Items found and waiting for the next delivery">
            {s.items.held} waiting for delivery
          </Badge>
        )}
        <span className="ml-auto text-xs text-subtle" data-testid="interest-meta">
          {[i.subCategory, i.vaultDir].filter(Boolean).join(' · ')}
        </span>
      </div>
      {i.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{i.description}</p>}
      {s.failing && s.lastError && <p className="mt-1 text-xs text-danger">{s.lastError}</p>}
      <div className="mt-2 grid gap-y-1 text-sm">
        <div data-testid="interest-cadence">
          {describeScan(i.scan)}
          {' · '}
          <span className="text-muted" data-testid="interest-next-scan">
            next {s.nextScanAt ? formatDateTime(s.nextScanAt) : 'not scheduled'}
          </span>
        </div>
        <div className="text-muted" data-testid="interest-delivery">
          Delivery: {describeDelivery(i.delivery)}
          {i.delivery.mode === 'scheduled' &&
            s.nextDeliveryAt &&
            ` · next ${formatDateTime(s.nextDeliveryAt)}`}
        </div>
        <div className="text-muted" data-testid="interest-last-run">
          {last ? (
            <>
              Last run {formatDateTime(s.lastRunAt)}: {RUN_STATUS_LABEL[last.status].toLowerCase()}
              {last.kind === 'scan' && last.found != null && `, found ${last.found}`}
              {last.published != null &&
                ` → ${last.published} ${last.kind === 'research' ? 'note' : 'published'}`}{' '}
              (
              <Link to={`/cards/${last.cardRef}`} className="underline">
                {last.cardRef}
              </Link>
              )
            </>
          ) : (
            'No run yet'
          )}
        </div>
        <div data-testid="interest-ratings">
          <span className="hidden sm:inline">Ratings {describeRatings(s.ratings)}</span>
          <span className="sm:hidden">{compactRatings(s.ratings)}</span>
          <span className="text-subtle">
            {' '}
            · runs 30d {s.runs30d} · items {s.items.total}
            {s.research.published > 0 && ` · notes ${s.research.published}`}
          </span>
        </div>
        {agents.length > 0 && (
          <div className="text-xs text-subtle" data-testid="interest-agents">
            {agents.join(' · ')} (preferred, any qualified agent may take a run)
          </div>
        )}
      </div>
      <ErrorBox error={run.error} />
      {run.data && (
        <p className="mt-2 text-sm" data-testid="interest-run-result">
          Started{' '}
          <Link to={`/cards/${run.data.ref}`} className="underline">
            {run.data.ref}
          </Link>
          .
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {i.canManage && !i.archived && (
          <>
            <Button
              variant="primary"
              className="min-h-11 sm:min-h-8"
              loading={run.isPending}
              data-testid="interest-run"
              onClick={() =>
                run.mutate({ id: i.id }, { onSuccess: (r) => toast.success(`Scan started: ${r.ref}`) })
              }
            >
              Run scan
            </Button>
            <Button className="min-h-11 sm:min-h-8" data-testid="interest-research" onClick={onResearch}>
              Research this
            </Button>
          </>
        )}
        <ButtonLink
          to={`/interests/${i.id}?tab=runs`}
          className="min-h-11 sm:min-h-8"
          data-testid="interest-runs-link"
        >
          Run log
        </ButtonLink>
        <ButtonLink
          to={`/interests/${i.id}?tab=digest`}
          className="min-h-11 sm:min-h-8"
          data-testid="interest-digests"
        >
          Digest
        </ButtonLink>
        <ButtonLink
          to={`/interests/${i.id}`}
          className="ml-auto min-h-11 sm:min-h-8"
          data-testid="interest-edit"
        >
          Open
        </ButtonLink>
      </div>
    </Panel>
  );
}
