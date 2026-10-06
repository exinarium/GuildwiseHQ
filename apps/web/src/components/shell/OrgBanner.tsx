import type { MeResponse, ProjectDto } from '@aom/shared';
import { Callout } from '../ui/Callout.tsx';

/**
 * Banners under the top bar (docs/design/organizations.md section 11.1): suspended and cancelled organizations,
 * a trial or licence ending, being over a limit (the last three for the Owner and Admins only; the server decides) and
 * "Viewing a guest project in <org>" when the project on screen belongs to an organization the user is only a guest in.
 */
export function OrgBanner({ me, project }: { me: MeResponse; project: ProjectDto | null }) {
  const active = me.activeOrg;
  const guestOf =
    project && active && project.orgId !== active.id
      ? (me.guestIn.find((g) => g.orgId === project.orgId)?.orgName ??
        project.orgName ??
        'another organization')
      : null;
  const banners = active?.banners ?? [];
  if (banners.length === 0 && !guestOf) return null;
  return (
    <div className="mx-auto w-full space-y-2 px-4 pt-4 sm:px-6 lg:px-8" data-testid="org-banners">
      {banners.map((b) => (
        <Callout key={b.kind} tone={b.severity} role={b.severity === 'danger' ? 'alert' : 'status'}>
          {b.message}
        </Callout>
      ))}
      {guestOf && (
        <Callout tone="info" role="status" data-testid="guest-banner">
          Viewing a guest project in <strong>{guestOf}</strong>. You work in it as a guest: the organization's
          owner and admins manage it.
        </Callout>
      )}
    </div>
  );
}
