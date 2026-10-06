import type { Workability } from '@aom/shared';
import { useId } from 'react';
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
 * could ever take the stage (blocked). Hover or keyboard focus shows the reason and, for a blocked card, a link to the
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
  if (!workability || workability.ok) return null;
  const blocked = workability.level !== 'waiting';
  const reason = workability.reason ?? (blocked ? 'Not workable' : 'Waiting');
  const hireUrl = hireUrlFor(workability, projectId);
  const hireLabel = workability.hire
    ? `Hire ${workability.hire.seniority ? `${workability.hire.seniority} ` : ''}${workability.hire.roleKey}`
    : '';
  return (
    <span
      className={`group relative inline-flex ${className}`}
      data-testid="workability-warning"
      data-level={blocked ? 'blocked' : 'waiting'}
    >
      <button
        type="button"
        aria-label={reason}
        aria-describedby={tipId}
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
      <span
        role="tooltip"
        id={tipId}
        data-testid="workability-reason"
        className="invisible absolute top-full right-0 z-20 mt-1 w-64 rounded-control border border-line bg-surface p-2 text-left text-xs font-normal text-fg shadow-lg group-focus-within:visible group-hover:visible"
      >
        {reason}
        {hireUrl && (
          <Link
            to={hireUrl}
            data-testid="workability-hire"
            className="mt-1.5 block font-medium text-brand-text underline"
          >
            {hireLabel}
          </Link>
        )}
      </span>
    </span>
  );
}
