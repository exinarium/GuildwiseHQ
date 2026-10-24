import { DISCOVERY_PHASE_LABEL, parseDiscoveryConfig, type SessionDto } from '@aom/shared';
import { Compass, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useDiscoverySessions } from '../api/queries/discovery.ts';
import { NewDiscoveryDialog } from '../components/discovery/NewDiscoveryDialog.tsx';
import { Badge, Button, EmptyState, ErrorBox, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { formatUsd, STANCE_LABEL } from '../lib/discovery.ts';
import { ageLabel } from '../lib/time.ts';

function Row({ s }: { s: SessionDto }) {
  const cfg = parseDiscoveryConfig(s.config);
  return (
    <li>
      <Link
        to={`/discovery/${s.threadId}`}
        data-testid="discovery-row"
        className="flex min-h-14 flex-col gap-1 rounded-card border border-line bg-surface px-4 py-3 hover:border-control sm:flex-row sm:items-center sm:gap-3"
      >
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{s.title}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Badge tone="brand">{DISCOVERY_PHASE_LABEL[cfg.phase]}</Badge>
          {cfg.archived && <Badge tone="neutral">Archived</Badge>}
          {cfg.paused && <Badge tone="warning">Paused</Badge>}
          {cfg.budgetStopped && <Badge tone="danger">Budget used up</Badge>}
          <span>{STANCE_LABEL[cfg.stance]}</span>
          <span className="tnum">{formatUsd(s.cost.costUsd)}</span>
          <span>{ageLabel(s.lastMessageAt ?? s.createdAt)}</span>
        </span>
      </Link>
    </li>
  );
}

/** Discovery sessions: where an idea becomes a brief or a PRD, with an analyst (and optionally the CEO). */
export function DiscoveryList() {
  const sessions = useDiscoverySessions();
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Discovery"
        sub="Turn an idea into a brief or a PRD. An analyst interviews you one question at a time."
        actions={
          <Button variant="primary" onClick={() => setOpen(true)} data-testid="new-discovery">
            <Plus aria-hidden="true" className="size-4" />
            New discovery
          </Button>
        }
      />
      {sessions.isPending && <ListSkeleton rows={3} />}
      <ErrorBox error={sessions.error} onRetry={() => void sessions.refetch()} />
      {sessions.data && sessions.data.length === 0 && (
        <EmptyState
          icon={Compass}
          tone="neutral"
          title="No discovery sessions yet"
          description="Start one when you have an idea that is not ready to build. The analyst keeps the notes and writes the PRD with you."
          action={
            <Button variant="primary" onClick={() => setOpen(true)}>
              New discovery
            </Button>
          }
        />
      )}
      {sessions.data && sessions.data.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Discovery sessions">
          {sessions.data.map((s) => (
            <Row key={s.threadId} s={s} />
          ))}
        </ul>
      )}
      <NewDiscoveryDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
