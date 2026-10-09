import type { Workability } from '@aom/shared';
import { Link } from 'react-router';
import { CardNotice } from './CardNotice.tsx';

/** HR board URL with the Hire form opened and prefilled for what a `blocked` card is missing. */
export function hireUrlFor(w: Workability, projectId: string | undefined): string | null {
  if (!w.hire) return null;
  const q = new URLSearchParams({ hire: w.hire.roleKey });
  if (w.hire.seniority) q.set('seniority', w.hire.seniority);
  if (projectId) q.set('projectId', projectId);
  return `/agents?${q.toString()}`;
}

/**
 * The "this card may never move" warning, as a banner on the card: amber when agents exist but are away or busy
 * (waiting), red when nobody hired could ever take the stage (blocked). The reason is written out on the card; for a
 * blocked card a link opens the HR board's Hire form prefilled with the missing role. Renders nothing for a workable card.
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
    <CardNotice
      testId="workability-warning"
      level={blocked ? 'danger' : 'warning'}
      summary={reason}
      className={className}
      action={
        (settingsUrl || hireUrl) && (
          <>
            {settingsUrl && (
              <Link to={settingsUrl} data-testid="workability-settings" className="font-medium underline">
                Open repository settings
              </Link>
            )}
            {hireUrl && (
              <Link to={hireUrl} data-testid="workability-hire" className="font-medium underline">
                {hireLabel}
              </Link>
            )}
          </>
        )
      }
    />
  );
}
