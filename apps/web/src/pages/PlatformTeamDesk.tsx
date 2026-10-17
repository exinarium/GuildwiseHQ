import { usePlatformTeamOverview } from '../api/queries/platformTeam.ts';
import { PlatformTeamPanels } from '../components/platform/PlatformTeamPanels.tsx';
import { EmptyState, ErrorBox, ListSkeleton, PageHeader } from '../components/ui.tsx';

/**
 * `/platform-team`: the platform organization's own view (its members read, its Owner and Admins act): pauses with
 * resume, bugs, safe-mode pins, grants and the deploy audit trail. Approvals themselves are items on the Desk.
 */
export function PlatformTeamDesk() {
  const overview = usePlatformTeamOverview();
  return (
    <div>
      <PageHeader title="Platform team" sub="Bugs, pauses, safe mode and deploys of Guildwise itself." />
      {overview.isPending && <ListSkeleton label="Loading" rows={3} />}
      {overview.isError && (
        <EmptyState
          title="Not available"
          description="Your organization is not the platform team, or you are not a member of its platform project."
        />
      )}
      {overview.isError && <ErrorBox error={overview.error} />}
      {overview.data && <PlatformTeamPanels data={overview.data} />}
    </div>
  );
}
