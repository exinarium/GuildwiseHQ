import type { ProjectDto } from '@aom/shared';
import {
  ArrowDown,
  ArrowUp,
  Code2,
  FlaskConical,
  FolderKanban,
  GripVertical,
  Rss,
  Settings,
} from 'lucide-react';
import { type DragEvent, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { projectTypeLabel } from './shell/ProjectSwitcher.tsx';
import { cx } from './ui/cx.ts';
import { Badge } from './ui.tsx';

const TYPE_ICON = { code: Code2, research: FlaskConical, feed: Rss } as const;

/** The order after moving `id` to `to` (a position in the list, 0-based). */
export function moveTo(ids: string[], id: string, to: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0 || to < 0 || to >= ids.length || from === to) return ids;
  const next = ids.slice();
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * The organization's projects, most important first. The Owner and Admins change the order by dragging a row (the grip),
 * or with the move up and move down buttons; the grip also answers the arrow keys, so everything works without a
 * pointer. Anyone else sees the order read-only. Each change is announced to screen readers.
 */
export function ProjectRankList({
  projects: given,
  canRank,
  disabledReason,
  onReorder,
}: {
  projects: ProjectDto[];
  canRank: boolean;
  /** Set while the list cannot be reordered (a filter hides some projects). */
  disabledReason?: string | undefined;
  /** Called with the new order of every project in `projects`; the promise settles when it is saved (or failed). */
  onReorder: (projectIds: string[]) => void | Promise<unknown>;
}) {
  const interactive = canRank && !disabledReason;
  // A move shows at once, before the parent's data has caught up (the next key press or drop must work on the new order):
  // `pending` holds the order just asked for until `projects` changes.
  const [pending, setPending] = useState<string[] | null>(null);
  const givenKey = given.map((p) => p.id).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the parent's list changed: it has caught up (or rolled back)
  useEffect(() => setPending(null), [givenKey]);
  const byId = new Map(given.map((p) => [p.id, p]));
  const projects =
    pending && pending.length === given.length && pending.every((id) => byId.has(id))
      ? pending.map((id) => byId.get(id) as ProjectDto)
      : given;
  const ids = projects.map((p) => p.id);
  const [dragId, setDragId] = useState<string | null>(null);
  // where the dragged row would land: the index of the row it is over
  const [over, setOver] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const refocus = useRef<{ id: string; control: 'up' | 'down' | 'grip' } | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());

  // After a move the same control must keep the focus (moving the row's element in the DOM drops it). A layout effect puts
  // it back before the browser handles the next key press.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after every reorder
  useLayoutEffect(() => {
    const f = refocus.current;
    if (!f) return;
    refocus.current = null;
    const el = rows.current.get(f.id)?.querySelector<HTMLElement>(`[data-control="${f.control}"]`);
    if (el && !el.hasAttribute('disabled')) el.focus();
    else rows.current.get(f.id)?.querySelector<HTMLElement>('[data-control]:not([disabled])')?.focus();
  }, [ids.join(',')]);

  const move = (p: ProjectDto, to: number, control: 'up' | 'down' | 'grip') => {
    const next = moveTo(ids, p.id, to);
    if (next === ids) return;
    refocus.current = { id: p.id, control };
    setAnnounce(`${p.name} moved to position ${to + 1} of ${ids.length}`);
    setPending(next);
    // once saved (or failed and rolled back) the parent's list is the truth again
    void Promise.resolve(onReorder(next))
      .catch(() => undefined)
      .finally(() => setPending((cur) => (cur === next ? null : cur)));
  };

  const onKey = (e: KeyboardEvent, p: ProjectDto, i: number) => {
    if (!interactive) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      move(p, i + (e.key === 'ArrowUp' ? -1 : 1), 'grip');
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      move(p, e.key === 'Home' ? 0 : ids.length - 1, 'grip');
    }
  };

  const drop = (e: DragEvent, target: number) => {
    e.preventDefault();
    const id = dragId ?? e.dataTransfer.getData('text/plain');
    setDragId(null);
    setOver(null);
    const p = projects.find((x) => x.id === id);
    if (p) move(p, target, 'grip');
  };

  return (
    <div data-testid="project-rank-list">
      <p role="status" aria-live="polite" className="sr-only" data-testid="rank-announce">
        {announce}
      </p>
      {canRank && (
        <p id="rank-help" className="mb-3 text-sm text-muted">
          {disabledReason ??
            'Drag a project by its grip to change its priority, or use the arrow buttons. With the grip focused, the up and down arrow keys move it too.'}
        </p>
      )}
      <ol className="flex flex-col gap-2">
        {projects.map((p, i) => {
          const Icon = TYPE_ICON[p.workflowKey as keyof typeof TYPE_ICON] ?? FolderKanban;
          const dragging = dragId === p.id;
          const showLineBefore = over === i && dragId !== null && dragId !== p.id && ids.indexOf(dragId) > i;
          const showLineAfter = over === i && dragId !== null && dragId !== p.id && ids.indexOf(dragId) < i;
          return (
            <li
              key={p.id}
              ref={(el) => {
                if (el) rows.current.set(p.id, el);
                else rows.current.delete(p.id);
              }}
              data-testid={`rank-row-${p.key}`}
              data-rank={i + 1}
              draggable={interactive}
              onDragStart={(e) => {
                if (!interactive) return;
                setDragId(p.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', p.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (!interactive || dragId === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (over !== i) setOver(i);
              }}
              onDrop={(e) => interactive && drop(e, i)}
              className={cx(
                'group relative flex items-center gap-3 rounded-card border border-line bg-surface p-3 pr-2 transition-shadow hover:border-control hover:shadow-md',
                dragging && 'opacity-50',
                showLineBefore &&
                  'before:absolute before:inset-x-2 before:-top-[5px] before:h-[3px] before:rounded-full before:bg-brand',
                showLineAfter &&
                  'after:absolute after:inset-x-2 after:-bottom-[5px] after:h-[3px] after:rounded-full after:bg-brand',
              )}
            >
              {interactive ? (
                <button
                  type="button"
                  data-control="grip"
                  data-testid={`rank-grip-${p.key}`}
                  aria-label={`Reorder ${p.name}: position ${i + 1} of ${projects.length}`}
                  aria-describedby="rank-help"
                  onKeyDown={(e) => onKey(e, p, i)}
                  className="-ml-1 inline-flex size-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-control text-subtle hover:bg-sunken hover:text-fg active:cursor-grabbing"
                >
                  <GripVertical aria-hidden="true" className="size-5" />
                </button>
              ) : null}
              <span
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-sunken text-sm font-semibold tabular-nums text-muted"
                title={`Priority ${i + 1}`}
                data-testid={`rank-number-${p.key}`}
              >
                <span className="sr-only">Priority </span>
                {i + 1}
              </span>
              <span className="hidden size-10 shrink-0 items-center justify-center rounded-control bg-brand-soft text-brand-soft-fg sm:flex">
                <Icon aria-hidden="true" className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <Link
                  to={`/p/${p.key}/board`}
                  className="block truncate text-lg font-semibold text-fg hover:underline"
                >
                  {p.name}
                </Link>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-subtle">
                  <span className="font-mono font-semibold text-muted">{p.key}</span>
                  <span aria-hidden="true">·</span>
                  {projectTypeLabel(p.workflowKey)}
                  {p.department && <Badge tone="violet">{p.department}</Badge>}
                  <Badge tone={p.myRole === 'owner' ? 'blue' : 'neutral'}>
                    {p.myRole === 'owner' ? 'owner' : 'shared with you'}
                  </Badge>
                </p>
              </div>
              {interactive && (
                <div className="flex shrink-0 items-center">
                  <button
                    type="button"
                    data-control="up"
                    data-testid={`rank-up-${p.key}`}
                    aria-label={`Move ${p.name} up`}
                    disabled={i === 0}
                    onClick={() => move(p, i - 1, 'up')}
                    className="inline-flex size-10 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg disabled:cursor-not-allowed disabled:text-disabled-fg disabled:hover:bg-transparent"
                  >
                    <ArrowUp aria-hidden="true" className="size-4" />
                  </button>
                  <button
                    type="button"
                    data-control="down"
                    data-testid={`rank-down-${p.key}`}
                    aria-label={`Move ${p.name} down`}
                    disabled={i === projects.length - 1}
                    onClick={() => move(p, i + 1, 'down')}
                    className="inline-flex size-10 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg disabled:cursor-not-allowed disabled:text-disabled-fg disabled:hover:bg-transparent"
                  >
                    <ArrowDown aria-hidden="true" className="size-4" />
                  </button>
                </div>
              )}
              <Link
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sunken hover:text-fg"
                aria-label={`Settings for ${p.key}`}
                title="Project settings"
                to={`/projects/${p.id}/settings`}
              >
                <Settings aria-hidden="true" className="size-4" />
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
