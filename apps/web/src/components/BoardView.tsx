import type { BoardCard, BoardResponse } from '@aom/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { BRAND } from '../brand.ts';
import { stageStyle } from '../lib/stages.ts';
import { ageLabel } from '../lib/time.ts';
import { useMediaQuery } from '../lib/useMediaQuery.ts';
import { BackoffBadge } from './BackoffBadge.tsx';
import { cx } from './ui/cx.ts';
import { Avatar, Badge, FilterChip } from './ui.tsx';
import { WorkabilityWarning } from './WorkabilityWarning.tsx';

const WAITING_LABEL = {
  bug: 'waiting on bug',
  approval: 'Awaiting your approval',
  finalizing: 'Finalizing',
  devops: 'waiting on DevOps',
} as const;

const HIDE_KEY = `${BRAND.storagePrefix}-board-hide-empty`;

export interface BoardFilter {
  text: string;
  blocked: boolean;
  rework: boolean;
  unassigned: boolean;
}
export const NO_FILTER: BoardFilter = { text: '', blocked: false, rework: false, unassigned: false };

export const matchesFilter = (c: BoardCard, f: BoardFilter): boolean => {
  const q = f.text.trim().toLowerCase();
  if (q && !`${c.ref} ${c.title} ${c.assignee?.name ?? ''}`.toLowerCase().includes(q)) return false;
  if (f.blocked && !c.blocked) return false;
  if (f.rework && c.reworkRound <= 0) return false;
  if (f.unassigned && c.assignee) return false;
  return true;
};

const riskTone = (r: string) => (r === 'medium' ? 'info' : r === 'large' ? 'warning' : 'danger');

export function CardTile({
  card,
  now,
  projectId,
  flash = false,
}: {
  card: BoardCard;
  now?: number;
  projectId?: string;
  flash?: boolean;
}) {
  const railed = card.blocked
    ? 'before:bg-danger-fill'
    : card.status === 'waiting'
      ? 'before:bg-warning-fill'
      : '';
  const quietRisk = !card.riskTier || card.riskTier === 'small';
  return (
    <li
      className={cx(
        'relative overflow-hidden rounded-card border border-line bg-surface shadow-sm transition-shadow hover:border-control hover:shadow-md',
        railed && 'before:absolute before:inset-y-0 before:left-0 before:z-10 before:w-[3px]',
        railed,
        flash && 'animate-flash',
      )}
    >
      <Link
        to={`/cards/${card.id}`}
        data-testid={`card-tile-${card.ref}`}
        aria-label={`${card.ref} ${card.title}`}
        className="block rounded-card p-3 text-base active:translate-y-px"
      >
        <div className="flex items-center justify-between gap-2 text-xs text-subtle">
          <span className="font-mono font-medium">{card.ref}</span>
          <span className="tnum" title={`Updated ${card.updatedAt}`}>
            {ageLabel(card.updatedAt, now)}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 leading-snug font-medium text-fg">{card.title}</p>
        <div
          className={`mt-2.5 flex flex-wrap items-center gap-1.5 ${card.workability && !card.workability.ok ? 'pr-6' : ''}`}
        >
          {card.assignee && (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted" data-testid="tile-assignee">
              <Avatar name={card.assignee.name} size={18} />
              {card.assignee.name}
            </span>
          )}
          {card.priority === 1 && (
            <Badge tone="danger" title="Priority 1 (urgent)">
              P1
            </Badge>
          )}
          {!quietRisk && card.riskTier && (
            <Badge tone={riskTone(card.riskTier)} title="Risk tier">
              {card.riskTier}
            </Badge>
          )}
          {card.reworkRound > 0 && (
            <Badge tone="violet" title="Rework round">
              Rework {card.reworkRound}
            </Badge>
          )}
          <BackoffBadge backoff={card.backoff} />
          {card.phase && (
            <span data-testid="phase-chip">
              <Badge tone={card.phase.assignment === 'proposed' ? 'amber' : 'blue'} title="Phase">
                {card.phase.ref}
                {card.phase.assignment === 'proposed' ? ' (proposed)' : ''}
              </Badge>
            </span>
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
        className="absolute right-2 bottom-2"
      />
      {card.status === 'waiting' && card.waitingOn && (
        <Link
          to={`/cards/${card.waitingOn.id}`}
          data-testid={`waiting-on-link-${card.waitingOn.ref}`}
          className="block border-t border-line px-3 py-1.5 text-xs text-brand-text underline"
        >
          waiting on {card.waitingOn.ref}
        </Link>
      )}
    </li>
  );
}

function readHide(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) !== 'no';
  } catch {
    return true;
  }
}

/**
 * Columns arrive from the server in display order (see `boardColumns`); we render them as given. Desktop: sideways
 * scroll with empty columns folded to a strip. Phones: a tab strip picks one column at a time (all stay in the DOM).
 */
export function BoardView({
  board,
  now,
  filter = NO_FILTER,
}: {
  board: BoardResponse;
  now?: number;
  filter?: BoardFilter;
}) {
  const wide = useMediaQuery('(min-width: 768px)', true);
  const [hideEmpty, setHideEmpty] = useState(readHide);
  const [picked, setPicked] = useState<string | null>(null);
  const cols = board.columns.map((c) => ({ ...c, cards: c.cards.filter((x) => matchesFilter(x, filter)) }));
  const total = cols.reduce((n, c) => n + c.cards.length, 0);

  // live updates: a card that changed column flashes and is announced
  const seen = useRef<Map<string, string>>(new Map());
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [said, setSaid] = useState('');
  useEffect(() => {
    const moved: BoardCard[] = [];
    const movedTo: string[] = [];
    const next = new Map<string, string>();
    for (const c of board.columns)
      for (const card of c.cards) {
        next.set(card.id, c.name);
        const was = seen.current.get(card.id);
        if (was && was !== c.name) {
          moved.push(card);
          movedTo.push(c.name);
        }
      }
    seen.current = next;
    if (moved.length) {
      setFlash(new Set(moved.map((m) => m.id)));
      setSaid(moved.map((m, i) => `${m.ref} moved to ${movedTo[i]}`).join('. '));
      const t = setTimeout(() => setFlash(new Set()), 1600);
      return () => clearTimeout(t);
    }
  }, [board]);

  const fallback =
    cols.find((c) => c.name === 'Blocked' && c.cards.length)?.name ??
    cols.find((c) => c.name === 'Review' && c.cards.length)?.name ??
    cols.find((c) => c.name === 'In progress' && c.cards.length)?.name ??
    cols.find((c) => c.cards.length)?.name ??
    cols[0]?.name ??
    '';
  const current = picked && cols.some((c) => c.name === picked) ? picked : fallback;

  const toggleHide = (v: boolean) => {
    setHideEmpty(v);
    try {
      localStorage.setItem(HIDE_KEY, v ? 'yes' : 'no');
    } catch {
      /* storage blocked */
    }
  };

  return (
    <div>
      <p role="status" aria-live="polite" className="sr-only">
        {said}
      </p>
      {!wide && (
        <div
          role="group"
          aria-label="Choose a column"
          className="scroll-fade-x sticky top-14 z-10 -mx-4 mb-3 flex gap-2 overflow-x-auto bg-canvas/95 px-4 py-2 backdrop-blur"
        >
          {cols.map((c) => {
            const s = stageStyle(c.name);
            return (
              <FilterChip
                key={c.name}
                pressed={c.name === current}
                count={c.cards.length}
                onClick={() => setPicked(c.name)}
              >
                <span aria-hidden="true" className="size-2 rounded-full" style={{ background: s.color }} />
                {c.name}
              </FilterChip>
            );
          })}
        </div>
      )}
      {wide && (
        <div className="mb-3 flex items-center justify-between gap-3 text-sm text-muted">
          <span className="tnum">{total} cards</span>
          <label className="inline-flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={hideEmpty}
              onChange={(e) => toggleHide(e.target.checked)}
              className="size-4"
            />
            Fold empty columns
          </label>
        </div>
      )}
      <section
        className={cx(
          'gap-3 pb-3',
          wide
            ? 'scroll-fade-x -mx-4 flex snap-x snap-proximity overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8'
            : 'block',
        )}
        data-testid="board"
        aria-label="Board columns"
        aria-describedby="board-hint"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard reachable
        tabIndex={0}
      >
        <span id="board-hint" className="sr-only">
          Scroll sideways to see more columns.
        </span>
        {cols.map((col) => {
          const s = stageStyle(col.name);
          const Icon = s.icon;
          const folded = wide && hideEmpty && col.cards.length === 0;
          const hidden = !wide && col.name !== current;
          return (
            <section
              key={col.name}
              aria-label={col.name}
              data-testid={`column-${col.name}`}
              hidden={hidden}
              className={cx(
                'relative flex shrink-0 snap-start flex-col overflow-hidden rounded-card bg-sunken',
                wide ? (folded ? 'w-14' : 'w-[17rem] flex-1 basis-[17rem]') : 'w-full',
              )}
            >
              <span aria-hidden="true" className="h-[3px] shrink-0" style={{ background: s.color }} />
              <div className={cx('p-2', folded && 'flex flex-1 flex-col items-center gap-3 py-3')}>
                <div className={cx('mb-2 flex items-center gap-2 px-1', folded && 'mb-0 flex-col')}>
                  <Icon aria-hidden="true" className="size-4 shrink-0" style={{ color: s.color }} />
                  <h2
                    className={cx(
                      'text-sm font-semibold text-fg',
                      !folded && 'flex flex-1 items-center justify-between',
                      folded && '[writing-mode:vertical-rl]',
                    )}
                  >
                    {col.name}
                    <span className="tnum ml-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-surface px-1.5 text-xs font-medium text-muted">
                      {col.cards.length}
                    </span>
                  </h2>
                </div>
                {!folded && (
                  <ul className="flex flex-col gap-2">
                    {col.cards.map((c) => (
                      <CardTile
                        key={c.id}
                        card={c}
                        projectId={board.projectId}
                        flash={flash.has(c.id)}
                        {...(now !== undefined ? { now } : {})}
                      />
                    ))}
                    {col.cards.length === 0 && (
                      <li className="rounded-control border border-dashed border-control/60 px-3 py-4 text-center text-sm text-subtle">
                        No cards
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </section>
          );
        })}
      </section>
    </div>
  );
}
