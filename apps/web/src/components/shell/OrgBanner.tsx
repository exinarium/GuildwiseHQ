import type { MeResponse, ProjectDto } from '@aom/shared';
import { Link } from 'react-router';
import type { RelayOfflineNotice } from '../../lib/relay.ts';
import { Callout } from '../ui/Callout.tsx';
import { RelayOfflineCallout } from './RelayOfflineCallout.tsx';

/**
 * Banners under the top bar (docs/design/organizations.md section 11.1): suspended and cancelled organizations,
 * a trial or licence ending, being over a limit (the last three for the Owner and Admins only; the server decides) and
 * "Viewing a guest project in <org>" when the project on screen belongs to an organization the user is only a guest in.
 */
export function OrgBanner({
  me,
  project,
  relayOffline = null,
}: {
  me: MeResponse;
  project: ProjectDto | null;
  /** Inbound webhooks with no runner and refused requests (computed by the shell; this component stays hook-free). */
  relayOffline?: RelayOfflineNotice | null;
}) {
  const active = me.activeOrg;
  const guestOf =
    project && active && project.orgId !== active.id
      ? (me.guestIn.find((g) => g.orgId === project.orgId)?.orgName ??
        project.orgName ??
        'another organization')
      : null;
  const banners = active?.banners ?? [];
  const simulation = active?.simulation === true;
  if (banners.length === 0 && !guestOf && !simulation && !relayOffline) return null;
  return (
    <div className="mx-auto w-full space-y-2 px-4 pt-4 sm:px-6 lg:px-8" data-testid="org-banners">
      {simulation && (
        <Callout tone="warning" role="status" title="Simulation" data-testid="simulation-banner">
          This is a simulation organization. Your agents work on a simulated workstation, so nothing real is
          built, nothing is billed, and emails are marked [Simulation].
        </Callout>
      )}
      {banners.map((b) => (
        <Callout key={b.kind} tone={b.severity} role={b.severity === 'danger' ? 'alert' : 'status'}>
          {b.message}
          {b.link && (
            <>
              {' '}
              <Link to={b.link} className="font-medium underline" data-testid="banner-link">
                Open Billing
              </Link>
            </>
          )}
        </Callout>
      ))}
      {relayOffline && <RelayOfflineCallout notice={relayOffline} />}
      {guestOf && (
        <Callout tone="info" role="status" data-testid="guest-banner">
          Viewing a guest project in <strong>{guestOf}</strong>. You work in it as a guest: the organization's
          owner and admins manage it.
        </Callout>
      )}
    </div>
  );
}
