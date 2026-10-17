import { useState } from 'react';
import { usePlatformOrgs } from '../../api/queries/platform.ts';
import {
  usePlatformTeamOverview,
  usePlatformTeamSettings,
  useSetPlatformTeam,
} from '../../api/queries/platformTeam.ts';
import { PlatformTeamPanels } from '../../components/platform/PlatformTeamPanels.tsx';
import { Badge, Button, Callout, ErrorBox, ListSkeleton, PageHeader, Panel } from '../../components/ui.tsx';

/**
 * `/platform/team`: the super admin designates the organization and project that run the platform team (and nothing
 * more: approvals and reports go to that organization's desk), and sees its pauses, bugs, pins and deploy audit trail.
 */
export function PlatformTeam() {
  const settings = usePlatformTeamSettings();
  const set = useSetPlatformTeam();
  const orgs = usePlatformOrgs({});
  const overview = usePlatformTeamOverview(!!settings.data?.orgId);
  const [orgId, setOrgId] = useState('');
  const [projectId, setProjectId] = useState('');
  return (
    <div>
      <PageHeader
        title="Platform team"
        sub="One organization of yours fixes Guildwise itself. Bugs the runners and the server report become cards in its platform project."
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
                Bugs are still recorded, but no cards are filed and nothing is raised until you designate one.
              </Callout>
            )}
            <p className="text-sm text-muted">
              Approvals and reports go to that organization's desk, not to you. Its project keeps its
              decisions at project level.
            </p>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                set.mutate({ orgId, projectId: projectId.trim() });
              }}
            >
              <label className="text-xs text-muted">
                Organization
                <select
                  className="mt-1 block w-64 rounded-control border border-border bg-surface px-2 py-1 text-sm"
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                >
                  <option value="">Pick an organization</option>
                  {(orgs.data ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-muted">
                Project id
                <input
                  className="mt-1 block w-72 rounded-control border border-border bg-surface px-2 py-1 text-sm"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  placeholder="project uuid (Project settings)"
                />
              </label>
              <Button
                type="submit"
                variant="primary"
                loading={set.isPending}
                disabled={!orgId || !projectId.trim()}
              >
                Designate
              </Button>
              {settings.data.orgId && (
                <Button loading={set.isPending} onClick={() => set.mutate({ orgId: null })}>
                  Clear
                </Button>
              )}
            </form>
            <ErrorBox error={set.error} />
          </div>
        </Panel>
      )}
      {overview.data && <PlatformTeamPanels data={overview.data} />}
    </div>
  );
}
