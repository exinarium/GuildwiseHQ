import { UserCog } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useCeoStatus } from '../api/queries/ceo.ts';
import { ActivityTab } from '../components/ceo/ActivityTab.tsx';
import { AuthorityTab } from '../components/ceo/AuthorityTab.tsx';
import { MemoryTab } from '../components/ceo/MemoryTab.tsx';
import { OverviewTab } from '../components/ceo/OverviewTab.tsx';
import { PersonaTab } from '../components/ceo/PersonaTab.tsx';
import { ReportingTab } from '../components/ceo/ReportingTab.tsx';
import { TasksTab } from '../components/ceo/TasksTab.tsx';
import { TopicsTab } from '../components/ceo/TopicsTab.tsx';
import { WorkstationsTab } from '../components/ceo/WorkstationsTab.tsx';
import { panelId, tabId } from '../components/ui/Tabs.tsx';
import { EmptyState, ErrorBox, PageHeader, PageSkeleton, Tabs } from '../components/ui.tsx';
import { useActiveOrgRole } from '../lib/orgRole.ts';

/**
 * `/org/ceo`: appoint, watch and steer the CEO agent (docs/design/ceo-agent-v2.md section 8). The Owner configures,
 * Admins read (and may pause); Members have no page.
 */
export function Ceo() {
  const role = useActiveOrgRole();
  const manager = role === 'owner' || role === 'admin';
  const owner = role === 'owner';
  const status = useCeoStatus(manager);
  const [params, setParams] = useSearchParams();

  if (role && !manager)
    return (
      <EmptyState
        icon={UserCog}
        title="The CEO page is for Owners and Admins"
        description="Ask an Owner or Admin of the organization about the CEO."
      />
    );
  if (!role || status.isPending)
    return (
      <div className="mx-auto max-w-5xl">
        <PageHeader title="CEO" />
        <PageSkeleton label="Loading the CEO" />
      </div>
    );
  if (!status.data)
    return (
      <div className="mx-auto max-w-5xl">
        <PageHeader title="CEO" />
        <ErrorBox error={status.error} onRetry={() => status.refetch()} />
      </div>
    );
  const s = status.data;
  // The CEO is built in: its tabs are always there (before it exists, the overview says it is being set up).
  const tabs = s.hired
    ? [
        { id: 'overview', label: 'Overview' },
        { id: 'authority', label: 'Authority' },
        { id: 'reporting', label: 'Reporting & alerts' },
        { id: 'persona', label: 'Persona & instructions' },
        { id: 'memory', label: 'Memory' },
        ...(owner ? [{ id: 'tasks', label: 'Tasks' }] : []),
        { id: 'topics', label: 'Topics' },
        { id: 'activity', label: 'Activity log' },
        { id: 'workstations', label: 'Workstations' },
      ]
    : [{ id: 'overview', label: 'Overview' }];
  const wanted = params.get('tab') ?? 'overview';
  const tab = tabs.some((t) => t.id === wanted) ? wanted : 'overview';
  const name = s.agent?.name ?? 'CEO';

  return (
    <div className="mx-auto flex max-w-5xl flex-col">
      <PageHeader
        title={s.hired ? name : 'CEO'}
        sub={
          s.hired
            ? 'Your chief executive: it handles the desk and the floor inside the limits you set.'
            : 'Your CEO is being set up.'
        }
      />
      {tabs.length > 1 && (
        <Tabs
          label="CEO"
          prefix="ceo"
          tabs={tabs}
          value={tab}
          onChange={(id) => setParams(id === 'overview' ? {} : { tab: id }, { replace: true })}
        />
      )}
      <div role="tabpanel" id={panelId('ceo', tab)} aria-labelledby={tabId('ceo', tab)}>
        {tab === 'overview' && <OverviewTab status={s} owner={owner} />}
        {tab === 'authority' && s.hired && <AuthorityTab status={s} />}
        {tab === 'reporting' && s.hired && <ReportingTab owner={owner} currency={s.spend.currency} />}
        {tab === 'persona' && s.hired && <PersonaTab owner={owner} />}
        {tab === 'memory' && s.hired && <MemoryTab owner={owner} />}
        {tab === 'tasks' && s.hired && owner && <TasksTab />}
        {tab === 'topics' && s.hired && <TopicsTab />}
        {tab === 'activity' && s.hired && <ActivityTab owner={owner} />}
        {tab === 'workstations' && s.hired && <WorkstationsTab status={s} owner={owner} />}
      </div>
    </div>
  );
}
