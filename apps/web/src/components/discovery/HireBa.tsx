import { UserPlus } from 'lucide-react';
import { ButtonLink, Callout } from '../ui.tsx';

/**
 * The organization has no BA: recommend hiring one. The button opens the full hire dialog on the Agents page with the built-in `ba`
 * role, a junior seniority and the session's project filled in (R3c), so the person sees and chooses the workstation, model and
 * access of the hire instead of getting a one-click default. The hand-off waits and starts on its own once the BA is online.
 */
export function HireBa({ canHire, projectId }: { canHire: boolean; projectId?: string | null }) {
  const to = `/agents?hire=ba&seniority=junior${projectId ? `&projectId=${projectId}` : ''}`;
  return (
    <Callout tone="warning" role="status" title="Your organization has no BA yet" data-testid="hire-ba">
      <p>
        The intake is a conversation with a business analyst. We recommend hiring one: the PRD waits and the
        intake starts on its own as soon as the BA's workstation is online.
      </p>
      {canHire && (
        <div className="mt-2">
          <ButtonLink to={to} variant="primary" size="sm" data-testid="hire-ba-button">
            <UserPlus aria-hidden="true" className="size-4" />
            Hire a BA
          </ButtonLink>
        </div>
      )}
    </Callout>
  );
}
