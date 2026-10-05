import type { BoardCard, BoardResponse } from '@aom/shared';
import { Link } from 'react-router';
import { ageLabel } from '../lib/time.ts';
import { Avatar, Badge } from './ui.tsx';
import { WorkabilityWarning } from './WorkabilityWarning.tsx';

const WAITING_LABEL = {
  bug: 'waiting on bug',
  approval: 'Awaiting your approval',
  finalizing: 'Finalizing',
  devops: 'waiting on DevOps',
} as const;

export function CardTile({ card, now, projectId }: { card: BoardCard; now?: number; projectId?: string }) {
  return (
    <li className="relative">
      <Link
        to={`/cards/${card.id}`}
        data-testid={`card-tile-${card.ref}`}
        aria-label={`${card.ref} ${card.title}`}
        className="block rounded-md border border-zinc-200 bg-white p-2 text-sm shadow-sm hover:border-indigo-500 dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
          <span className="font-mono font-medium">{card.ref}</span>
          <span title={`Updated ${card.updatedAt}`}>{ageLabel(card.updatedAt, now)}</span>
        </div>
        <p className="mt-1 line-clamp-2 font-medium leading-snug">{card.title}</p>
        <div
          className={`mt-2 flex flex-wrap items-center gap-1.5 ${card.workability && !card.workability.ok ? 'pr-6' : ''}`}
        >
          {card.assignee ? (
            <span className="inline-flex items-center gap-1 text-xs" data-testid="tile-assignee">
              <Avatar name={card.assignee.name} size={18} />
              {card.assignee.name}
            </span>
          ) : (
            <span className="text-xs text-zinc-400">Unassigned</span>
          )}
          {card.riskTier && (
            <Badge tone={card.riskTier === 'large' ? 'amber' : 'neutral'} title="Risk tier">
              {card.riskTier}
            </Badge>
          )}
          {card.reworkRound > 0 && (
            <Badge tone="violet" title="Rework round">
              Rework {card.reworkRound}
            </Badge>
          )}
          {card.blocked && <Badge tone="red">Blocked</Badge>}
          {card.status === 'waiting' && (
            <span data-testid="waiting-badge">
              <Badge tone="amber">{WAITING_LABEL[card.waitingFor ?? 'bug']}</Badge>
            </span>
          )}
          {(card.origin === 'full_suite' || card.origin === 'regression') && (
            <span data-testid="suite-badge">
              <Badge tone="blue">{card.origin === 'full_suite' ? 'full suite' : 'regression'}</Badge>
            </span>
          )}
        </div>
      </Link>
      <WorkabilityWarning
        workability={card.workability}
        projectId={projectId}
        className="absolute right-1.5 bottom-1.5"
      />
      {card.status === 'waiting' && card.waitingOn && (
        <Link
          to={`/cards/${card.waitingOn.id}`}
          data-testid={`waiting-on-link-${card.waitingOn.ref}`}
          className="mt-0.5 ml-2 inline-block text-xs underline"
        >
          waiting on {card.waitingOn.ref}
        </Link>
      )}
    </li>
  );
}

/** Columns arrive from the server in display order (see `boardColumns`); we render them as given. */
export function BoardView({ board, now }: { board: BoardResponse; now?: number }) {
  return (
    <section
      className="flex gap-3 overflow-x-auto pb-3"
      data-testid="board"
      aria-label="Board columns"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
      tabIndex={0}
    >
      {board.columns.map((col) => (
        <section
          key={col.name}
          aria-label={col.name}
          data-testid={`column-${col.name}`}
          className="flex w-64 shrink-0 flex-col rounded-lg bg-zinc-100/70 p-2 dark:bg-zinc-900/60"
        >
          <h2 className="mb-2 flex items-center justify-between px-1 text-xs font-semibold tracking-wide text-zinc-600 uppercase dark:text-zinc-400">
            {col.name}
            <span className="rounded bg-zinc-200 px-1.5 text-[11px] dark:bg-zinc-800">
              {col.cards.length}
            </span>
          </h2>
          <ul className="flex flex-col gap-2">
            {col.cards.map((c) => (
              <CardTile
                key={c.id}
                card={c}
                projectId={board.projectId}
                {...(now !== undefined ? { now } : {})}
              />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
