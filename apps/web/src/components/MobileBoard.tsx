import type { BoardCard } from '@aom/shared';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { BRAND } from '../brand.ts';
import { DEFAULT_PRIORITY, priorityLabel, priorityLevel } from '../lib/priority.ts';
import { stageStyle } from '../lib/stages.ts';
import { ageLabel } from '../lib/time.ts';
import { BlockedReasonNotice } from './BoardCardNotices.tsx';
import { MoveToSheet } from './cards/MoveToSheet.tsx';
import { AgentAvatar } from './Face.tsx';
import { cx } from './ui/cx.ts';
import { Badge } from './ui.tsx';

/** A card the owner has to look at: blocked, waiting on someone (QA, approval, a bug, ...). */
export const needsAttention = (c: BoardCard): boolean =>
  c.blocked || c.status === 'blocked' || c.status === 'waiting' || !!c.qa || !!c.approval;

const storeKey = (projectId: string) => `${BRAND.storagePrefix}-board-accordion-${projectId}`;

/** The sections the user opened or closed by hand on this project (column name -> open); {} when none or no storage. */
export function readAccordion(projectId: string): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(storeKey(projectId)) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeAccordion(projectId: string, v: Record<string, boolean>) {
  try {
    localStorage.setItem(storeKey(projectId), JSON.stringify(v));
  } catch {
    /* storage blocked */
  }
}

const WAITING = {
  bug: 'Waiting on bug',
  approval: 'Awaiting your approval',
  finalizing: 'Finalizing',
  devops: 'Waiting on DevOps',
  subworkflow: 'Waiting for sub-workflow',
  qa: 'Waiting for QA',
  approval_step: 'Waiting for approval',
} as const;

function CardRow({
  card,
  now,
  flash,
  onMove,
}: {
  card: BoardCard;
  now?: number | undefined;
  flash: boolean;
  onMove: () => void;
}) {
  const level = priorityLevel(card.priority).key;
  return (
    <li
      className={cx(
        'relative flex items-stretch overflow-hidden rounded-card border border-line bg-surface',
        card.blocked && 'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-danger-fill',
        flash && 'animate-flash',
      )}
    >
      <Link
        to={`/cards/${card.id}`}
        data-testid={`card-tile-${card.ref}`}
        aria-label={`${card.ref} ${card.title}`}
        className="block min-h-11 min-w-0 flex-1 p-3"
      >
        <div className="flex items-center justify-between gap-2 text-xs text-subtle">
          <span className="font-mono font-medium">{card.ref}</span>
          <span className="tnum">{ageLabel(card.updatedAt, now)}</span>
        </div>
        <p className="mt-1 line-clamp-2 leading-snug font-medium text-fg">{card.title}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {card.blocked && <Badge tone="red">Blocked</Badge>}
          {card.status === 'waiting' && <Badge tone="amber">{WAITING[card.waitingFor ?? 'bug']}</Badge>}
          {card.qa && <Badge tone="amber">QA: {card.qa.assigneeName}</Badge>}
          {card.approval && <Badge tone="amber">Approval: {card.approval.approverName}</Badge>}
          {card.priority !== DEFAULT_PRIORITY && (
            <Badge tone={level === 'urgent' ? 'danger' : level === 'high' ? 'warning' : 'neutral'}>
              {priorityLabel(card.priority)}
            </Badge>
          )}
          {card.reworkRound > 0 && <Badge tone="violet">Rework {card.reworkRound}</Badge>}
          {card.phase && (
            <Badge tone={card.phase.assignment === 'proposed' ? 'amber' : 'blue'}>{card.phase.ref}</Badge>
          )}
          {card.assignee && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <AgentAvatar agentId={card.assignee.agentId} name={card.assignee.name} size={18} />
              {card.assignee.name}
            </span>
          )}
        </div>
        <BlockedReasonNotice reason={card.blockedReason} />
      </Link>
      <button
        type="button"
        aria-label={`Actions for ${card.ref}: Move to...`}
        data-testid={`card-actions-${card.ref}`}
        onClick={onMove}
        className="flex w-11 shrink-0 items-center justify-center border-l border-line text-muted active:bg-sunken"
      >
        <MoreHorizontal aria-hidden="true" className="size-5" />
      </button>
    </li>
  );
}

/**
 * The phone board: one accordion section per column in workflow order (a header with the column's name, card count
 * and blocked count). Sections with cards that need attention start open and empty ones closed; what the user opens or
 * closes is remembered per project. "Move to..." replaces drag and drop.
 */
export function MobileBoard({
  projectId,
  workflowKey,
  columns,
  filtering,
  now,
  flash,
}: {
  projectId: string;
  workflowKey: string;
  columns: { name: string; cards: BoardCard[] }[];
  /** A filter is on: every column with matches starts open. */
  filtering: boolean;
  now?: number | undefined;
  flash: Set<string>;
}) {
  const [manual, setManual] = useState(() => readAccordion(projectId));
  const [moving, setMoving] = useState<BoardCard | null>(null);
  const anyAttention = columns.some((c) => c.cards.some(needsAttention));
  const firstFilled = columns.find((c) => c.cards.length > 0)?.name;
  const isOpen = (c: { name: string; cards: BoardCard[] }) => {
    const mine = manual[c.name];
    if (mine !== undefined) return mine;
    if (c.cards.length === 0) return false;
    if (filtering) return true;
    return anyAttention ? c.cards.some(needsAttention) : c.name === firstFilled;
  };
  const toggle = (c: { name: string; cards: BoardCard[] }) => {
    const next = { ...manual, [c.name]: !isOpen(c) };
    setManual(next);
    writeAccordion(projectId, next);
  };
  return (
    <div data-testid="board" className="flex flex-col gap-2 pb-3">
      {columns.map((col) => {
        const s = stageStyle(col.name);
        const Icon = s.icon;
        const open = isOpen(col);
        const blocked = col.cards.filter((c) => c.blocked).length;
        return (
          <section
            key={col.name}
            aria-label={col.name}
            data-testid={`column-${col.name}`}
            className="overflow-hidden rounded-card bg-sunken"
          >
            <h2>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`board-sec-${col.name}`}
                onClick={() => toggle(col)}
                className="flex min-h-12 w-full items-center gap-2 px-3 text-left text-sm font-semibold text-fg"
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" style={{ color: s.color }} />
                <span className="min-w-0 flex-1 truncate">{col.name}</span>
                {blocked > 0 && (
                  <Badge tone="red" title="Blocked cards">
                    {blocked} blocked
                  </Badge>
                )}
                <span className="tnum inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface px-1.5 text-xs font-medium text-muted">
                  {col.cards.length}
                  <span className="sr-only"> cards</span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cx('size-4 shrink-0 text-subtle transition-transform', open && 'rotate-180')}
                />
              </button>
            </h2>
            <div id={`board-sec-${col.name}`} hidden={!open} className="px-2 pb-2">
              <ul className="flex flex-col gap-2">
                {col.cards.map((c) => (
                  <CardRow
                    key={c.id}
                    card={c}
                    now={now}
                    flash={flash.has(c.id)}
                    onMove={() => setMoving(c)}
                  />
                ))}
                {col.cards.length === 0 && (
                  <li className="rounded-control border border-dashed border-control/60 px-3 py-4 text-center text-sm text-subtle">
                    No cards
                  </li>
                )}
              </ul>
            </div>
          </section>
        );
      })}
      {moving && (
        <MoveToSheet
          card={{
            id: moving.id,
            stage: moving.stage,
            ref: moving.ref,
            projectId,
            workflowKey: moving.workflowKey ?? workflowKey,
          }}
          open
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}
