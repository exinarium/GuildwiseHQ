import { ChevronDown, TriangleAlert } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cx } from './ui/cx.ts';

export type NoticeLevel = 'danger' | 'warning';

const LEVEL: Record<NoticeLevel, string> = {
  danger: 'border-danger-fill/40 bg-danger-soft text-danger-soft-fg',
  warning: 'border-warning-fill/40 bg-warning-soft text-warning-soft-fg',
};

/** Past this many characters the folded two lines may cut the text, so the toggle is offered. */
const FOLD_AT = 70;

/**
 * A warning shown on the card itself: a short readable line in the level's colour (never an icon alone, never a
 * hover-only tooltip), the full reason one tap or key press away (it unfolds in place, so no overflow can clip it, and
 * the same text is the native hover title), and the fix action when there is one. The text is in the page for screen
 * readers; the toggle says whether it is expanded.
 */
export function CardNotice({
  level,
  summary,
  detail,
  action,
  testId,
  className,
}: {
  level: NoticeLevel;
  /** The short line (two lines at most while folded). */
  summary: string;
  /** More to say than the summary, shown when unfolded (and part of the hover title). */
  detail?: string | undefined;
  /** The fix: a link or button, always visible. */
  action?: ReactNode;
  testId?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const full = detail ? `${summary} ${detail}` : summary;
  const foldable = !!detail || summary.length > FOLD_AT;
  return (
    <div
      data-testid={testId}
      data-level={level === 'danger' ? 'blocked' : 'waiting'}
      title={full}
      className={cx('flex flex-col gap-1 border-t px-3 py-2 text-xs', LEVEL[level], className)}
    >
      <div className="flex items-start gap-1.5">
        <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <p
          id={id}
          data-testid={testId ? `${testId}-text` : undefined}
          className={cx('min-w-0 flex-1 leading-snug font-medium break-words', !open && 'line-clamp-2')}
        >
          {summary}
          {open && detail && <span className="mt-1 block font-normal">{detail}</span>}
        </p>
        {foldable && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-label={open ? 'Show less' : 'Show the full reason'}
            onClick={() => setOpen((o) => !o)}
            className="-m-1 inline-flex size-8 shrink-0 items-center justify-center rounded-control hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring dark:hover:bg-white/10"
          >
            <ChevronDown
              aria-hidden="true"
              className={cx('size-4 transition-transform', open && 'rotate-180')}
            />
          </button>
        )}
      </div>
      {action}
    </div>
  );
}
