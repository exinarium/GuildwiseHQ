import { isOrgManager, type OrgChartAgent } from '@aom/shared';
import { Network } from 'lucide-react';
import { useState } from 'react';
import { useOrgChart } from '../api/queries/costs.ts';
import { AgentDialog } from '../components/orgchart/AgentDialog.tsx';
import { ChartCanvas } from '../components/orgchart/ChartCanvas.tsx';
import { DevopsPanel } from '../components/orgchart/DevopsPanel.tsx';
import { ListView } from '../components/orgchart/ListView.tsx';
import { EmptyState, ErrorBox, PageHeader, PageSkeleton, Segmented, Select } from '../components/ui.tsx';
import { worksOn } from '../lib/orgChart.ts';
import { useActiveOrgRole } from '../lib/orgRole.ts';
import { useIsTabletUp } from '../lib/useMediaQuery.ts';
import { usePageTitle } from '../lib/usePageTitle.ts';

/**
 * Organization, Org chart: who is on the floor, how questions climb (a senior of the role, then the BA, then you) and
 * whom each agent reports to. Faces, status and workstation on every tile; filters by project; click for the card.
 */
export function OrgChartPage() {
  usePageTitle('Org chart');
  const q = useOrgChart();
  const role = useActiveOrgRole();
  const wide = useIsTabletUp();
  const [view, setView] = useState<'chart' | 'list' | null>(null);
  const [project, setProject] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  if (q.isPending)
    return (
      <div>
        <PageHeader title="Org chart" />
        <PageSkeleton label="Loading the org chart" panels={2} />
      </div>
    );
  if (q.isError)
    return (
      <div>
        <PageHeader title="Org chart" />
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  const chart = q.data;
  const shown = chart.agents.filter((a) => worksOn(a, project));
  const tree = shown.filter((a) => !a.isDevops);
  const current = view ?? (wide ? 'chart' : 'list');
  const selected = chart.agents.find((a) => a.id === open) ?? null;
  const onOpen = (a: OrgChartAgent) => setOpen(a.id);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Org chart"
        sub={
          <span className="tnum" data-testid="org-summary">
            {tree.length} agent{tree.length === 1 ? '' : 's'}
            {project && ` allowed on ${chart.projects.find((p) => p.id === project)?.key ?? 'this project'}`}
            {' in '}
            {new Set(tree.map((a) => a.department ?? 'other')).size} department
            {new Set(tree.map((a) => a.department ?? 'other')).size === 1 ? '' : 's'}
          </span>
        }
        actions={
          <Segmented
            label="View"
            value={current}
            onChange={setView}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'list', label: 'List' },
            ]}
          />
        }
      />
      {chart.agents.length === 0 ? (
        <EmptyState
          icon={Network}
          title="Nobody works here yet"
          description="Hire your first agent and it appears on the chart, with whom it reports to and who answers its questions."
        />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-64">
              <Select
                label="Allowed on project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                data-testid="org-project-filter"
              >
                <option value="">All projects</option>
                {chart.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <p className="pb-2 text-sm text-muted">
              Agents allowed on any project always show; pick a project to see who may work it.
            </p>
          </div>
          {current === 'chart' ? (
            <ChartCanvas
              chart={chart}
              agents={shown}
              onOpen={onOpen}
              canHire={isOrgManager({ orgRole: role })}
            />
          ) : (
            <ListView chart={chart} agents={shown} onOpen={onOpen} />
          )}
          <DevopsPanel chart={{ ...chart, workstations: chart.workstations }} onOpen={onOpen} />
        </>
      )}
      <AgentDialog agent={selected} chart={chart} onClose={() => setOpen(null)} />
    </div>
  );
}
