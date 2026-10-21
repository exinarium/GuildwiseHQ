import { useNavigate } from 'react-router';
import { Tabs } from './ui/Tabs.tsx';

/** The tabs under a project's page header: its board and its backlog. */
export function ProjectTabs({ projectKey, active }: { projectKey: string; active: 'board' | 'backlog' }) {
  const navigate = useNavigate();
  return (
    <Tabs
      label="Project"
      prefix="project"
      value={active}
      tabs={[
        { id: 'board', label: 'Board', testId: 'project-tab-board' },
        { id: 'backlog', label: 'Backlog', testId: 'project-tab-backlog' },
      ]}
      onChange={(id) => {
        if (id !== active) navigate(`/p/${projectKey}/${id}`);
      }}
    />
  );
}
