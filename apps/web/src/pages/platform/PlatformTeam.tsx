import { usePlatformTeamSettings } from '../../api/queries/platformTeam.ts';
import { Badge, Callout, ErrorBox, ListSkeleton, PageHeader, Panel } from '../../components/ui.tsx';

/**
 * `/platform/team`: which organization and project run the platform team. Read-only (R17-1): the designation is server
 * config (`AOM_PLATFORM_TEAM_ORG_ID`, `AOM_PLATFORM_TEAM_PROJECT_ID`), and the super admin does not see the team's
 * bugs, pauses or pins: those belong to the platform organization, which works on its own desk.
 */
export function PlatformTeam() {
  const settings = usePlatformTeamSettings();
  return (
    <div>
      <PageHeader
        title="Platform team"
        sub="One organization fixes Guildwise itself. Bugs the runners and the server report become cards in its platform project."
      />
      {settings.isPending && <ListSkeleton label="Loading" rows={1} />}
      {settings.isError && <ErrorBox error={settings.error} onRetry={() => settings.refetch()} />}
      {settings.data && (
        <Panel title="Designation" className="mb-4 max-w-3xl">
          <div className="flex flex-col gap-3" data-testid="platform-team-designation">
            {settings.data.orgId ? (
              <p className="text-sm">
                Organization <strong>{settings.data.orgName}</strong>, project{' '}
                <strong>
                  {settings.data.projectKey} {settings.data.projectName}
                </strong>{' '}
                <Badge tone="success">Designated</Badge>
              </p>
            ) : (
              <Callout tone="warning" title="No platform team designated">
                Bugs are still recorded, but no cards are filed and nothing is raised until one is designated.
              </Callout>
            )}
            {settings.data.source === 'legacy' ? (
              <Callout
                tone="warning"
                title="Move the designation to the server config"
                data-testid="platform-team-legacy"
              >
                This designation was made in an older version and is read-only. Set AOM_PLATFORM_TEAM_ORG_ID
                and AOM_PLATFORM_TEAM_PROJECT_ID on the server to keep it.
              </Callout>
            ) : (
              <p className="text-sm text-muted">
                The designation is set in the server config (AOM_PLATFORM_TEAM_ORG_ID and
                AOM_PLATFORM_TEAM_PROJECT_ID), not here.
              </p>
            )}
            <p className="text-sm text-muted">
              The team's bugs, pauses and runner pins are on that organization's own platform page. Its pauses
              and pins stay inside that organization; to stop a client organization, suspend it.
            </p>
          </div>
        </Panel>
      )}
    </div>
  );
}
