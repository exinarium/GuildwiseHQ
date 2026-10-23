import { BOARD_FORMAT_LABEL, parseBoardConfig, type SessionDto } from '@aom/shared';
import { Plus, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useBoardSessions } from '../api/queries/boardroom.ts';
import { NewBoardroomDialog } from '../components/boardroom/NewBoardroomDialog.tsx';
import { Badge, Button, EmptyState, ErrorBox, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { formatUsd } from '../lib/discovery.ts';
import { useCanManageOrg } from '../lib/orgRole.ts';
import { ageLabel } from '../lib/time.ts';

function Row({ s }: { s: SessionDto }) {
  const cfg = parseBoardConfig(s.config);
  const seats = s.participants.filter((p) => p.kind !== 'user' && p.seat !== 'Chair').length;
  return (
    <li>
      <Link
        to={`/boardroom/${s.threadId}`}
        data-testid="boardroom-row"
        className="flex min-h-14 flex-col gap-1 rounded-card border border-line bg-surface px-4 py-3 hover:border-control sm:flex-row sm:items-center sm:gap-3"
      >
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{s.title}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {cfg.stage === 'ended' ? (
            <Badge tone="neutral">Over</Badge>
          ) : cfg.stage === 'setup' ? (
            <Badge tone="warning">Setting up</Badge>
          ) : (
            <Badge tone="brand">
              Round {cfg.round} of {cfg.roundCap}
            </Badge>
          )}
          {cfg.paused && <Badge tone="warning">Paused</Badge>}
          {cfg.stage === 'decision' && <Badge tone="warning">Needs your decision</Badge>}
          {cfg.budgetStopped && <Badge tone="danger">Budget used up</Badge>}
          <span>{BOARD_FORMAT_LABEL[cfg.format]}</span>
          {seats > 0 && <span>{seats} seats</span>}
          <span className="tnum">{formatUsd(s.cost.costUsd)}</span>
          <span>{ageLabel(s.lastMessageAt ?? s.createdAt)}</span>
        </span>
      </Link>
    </li>
  );
}

/** Boardroom sessions: a Chair runs personas and agents through a question; the owner can interject at any time. */
export function BoardroomList() {
  const sessions = useBoardSessions();
  const canManage = useCanManageOrg();
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Boardroom"
        sub="Put a question to a group of personas and agents. Everyone answers on their own first, then a Chair runs the debate."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setOpen(true)} data-testid="new-boardroom">
              <Plus aria-hidden="true" className="size-4" />
              New boardroom
            </Button>
          ) : undefined
        }
      />
      {sessions.isPending && <ListSkeleton rows={3} />}
      <ErrorBox error={sessions.error} onRetry={() => void sessions.refetch()} />
      {sessions.data && sessions.data.length === 0 && (
        <EmptyState
          icon={Users}
          tone="neutral"
          title="No boardrooms yet"
          description="Start one when a decision deserves more than one view. The minutes can become the start of a PRD."
          action={
            canManage ? (
              <Button variant="primary" onClick={() => setOpen(true)}>
                New boardroom
              </Button>
            ) : undefined
          }
        />
      )}
      {sessions.data && sessions.data.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Boardrooms">
          {sessions.data.map((s) => (
            <Row key={s.threadId} s={s} />
          ))}
        </ul>
      )}
      <NewBoardroomDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
