import { useNavigate } from 'react-router';
import { useProject } from '../api/queries/projects.ts';
import { Tabs } from './ui/Tabs.tsx';

type Tab = 'board' | 'backlog' | 'pull-requests';

/**
 * The tabs under a project's page header: its board and its backlog, and, when a repository of the project is PR-only
 * (pass `projectId`), its pull requests.
 */
export function ProjectTabs({
  projectKey,
  projectId,
  active,
}: {
  projectKey: string;
  projectId?: string;
  active: Tab;
}) {
  const navigate = useNavigate();
  const detail = useProject(projectId);
  const showPrs = active === 'pull-requests' || !!detail.data?.repos?.some((r) => r.prOnly && !r.removedAt);
  return (
    <Tabs
      label="Project"
      prefix="project"
      value={active}
      tabs={[
        { id: 'board', label: 'Board', testId: 'project-tab-board' },
        { id: 'backlog', label: 'Backlog', testId: 'project-tab-backlog' },
        ...(showPrs
          ? [{ id: 'pull-requests', label: 'Pull requests', testId: 'project-tab-pull-requests' }]
          : []),
      ]}
      onChange={(id) => {
        if (id !== active) navigate(`/p/${projectKey}/${id}`);
      }}
    />
  );
}
