import type { Workability } from '@aom/shared';
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';

/** HR board URL with the Hire form opened and prefilled for what a `blocked` card is missing. */
export function hireUrlFor(w: Workability, projectId: string | undefined): string | null {
  if (!w.hire) return null;
  const q = new URLSearchParams({ hire: w.hire.roleKey });
  if (w.hire.seniority) q.set('seniority', w.hire.seniority);
  if (projectId) q.set('projectId', projectId);
  return `/agents?${q.toString()}`;
}

/**
 * The "this card may never move" icon: amber when agents exist but are away or busy (waiting), red when nobody hired
 * could ever take the stage (blocked). Hover, keyboard focus or a click/tap opens a portalled popover (it escapes the board card's `overflow-hidden`, flips near the viewport edge, Esc closes) with the reason and, for a blocked card, a link to the
 * HR board's Hire form prefilled with the missing role. Renders nothing for a workable card.
 */
export function WorkabilityWarning({
  workability,
  projectId,
  className = '',
}: {
  workability: Workability | undefined;
  projectId?: string | undefined;
  className?: string;
}) {
  const tipId = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Opened by hovering: a click then keeps it open instead of toggling it shut.
  const byHover = useRef(false);
  const pointerFocus = useRef(false);
  const openSoon = () => {
    clearTimeout(timer.current);
    if (!open) byHover.current = true;
    setOpen(true);
  };
  const closeSoon = () => {
    clearTimeout(timer.current);
    // A popover the user pinned with a click stays until they dismiss it.
    if (!byHover.current) return;
    timer.current = setTimeout(() => setOpen(false), 120);
  };
  if (!workability || workability.ok) return null;
  const blocked = workability.level !== 'waiting';
  const reason = workability.reason ?? (blocked ? 'Not workable' : 'Waiting');
  const hireUrl = hireUrlFor(workability, projectId);
  const settingsUrl =
    workability.settings === 'repositories' && projectId ? `/projects/${projectId}/settings#repos` : null;
  const hireLabel = workability.hire
    ? `Hire ${workability.hire.seniority ? `${workability.hire.seniority} ` : ''}${workability.hire.roleKey}`
    : '';
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) byHover.current = false;
        setOpen(o);
      }}
    >
      <span
        className={`inline-flex ${className}`}
        data-testid="workability-warning"
        data-level={blocked ? 'blocked' : 'waiting'}
      >
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label={reason}
            aria-describedby={open ? tipId : undefined}
            onClick={(e) => {
              if (open && byHover.current) e.preventDefault();
              byHover.current = false;
            }}
            onPointerEnter={(e) => e.pointerType === 'mouse' && openSoon()}
            onPointerLeave={(e) => e.pointerType === 'mouse' && closeSoon()}
            onPointerDown={() => {
              pointerFocus.current = true;
            }}
            onBlur={() => {
              pointerFocus.current = false;
            }}
            onFocus={() => {
              // Focus from a mouse or touch press is followed by a click, which opens (and must not toggle shut).
              if (pointerFocus.current) return;
              byHover.current = false;
              setOpen(true);
            }}
            className={`rounded p-1 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
              blocked ? 'text-danger ' : 'text-warning '
            }`}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </Popover.Trigger>
      </span>
      <Popover.Portal>
        <Popover.Content
          role="tooltip"
          id={tipId}
          data-testid="workability-reason"
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={12}
          avoidCollisions
          onPointerEnter={openSoon}
          onPointerLeave={closeSoon}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-90 w-64 max-w-[calc(100vw-1.5rem)] rounded-control border border-line bg-surface p-2 text-left text-xs font-normal text-fg shadow-lg"
        >
          {reason}
          {settingsUrl && (
            <Link
              to={settingsUrl}
              data-testid="workability-settings"
              className="mt-1.5 block font-medium text-brand-text underline"
            >
              Open repository settings
            </Link>
          )}
          {hireUrl && (
            <Link
              to={hireUrl}
              data-testid="workability-hire"
              className="mt-1.5 block font-medium text-brand-text underline"
            >
              {hireLabel}
            </Link>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
