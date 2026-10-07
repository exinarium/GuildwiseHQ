import { createBrowserRouter, Navigate } from 'react-router';
import { useProjects } from './api/queries/projects.ts';
import { RequireAuth } from './components/Layout.tsx';
import { PlatformShell } from './components/platform/PlatformShell.tsx';
import { RouteError } from './components/RouteError.tsx';
import { PageSkeleton } from './components/ui.tsx';
import { getLastProjectKey } from './lib/lastProject.ts';
import { AcceptInvite } from './pages/AcceptInvite.tsx';
import { Agents } from './pages/Agents.tsx';
import { Board } from './pages/Board.tsx';
import { CardDetail } from './pages/CardDetail.tsx';
import { CardNew } from './pages/CardNew.tsx';
import { Chat } from './pages/Chat.tsx';
import { Desk } from './pages/Desk.tsx';
import { FeedProject } from './pages/FeedProject.tsx';
import { IntakeNew, IntakeView } from './pages/Intake.tsx';
import { Interests } from './pages/Interests.tsx';
import { Ledger } from './pages/Ledger.tsx';
import { Login } from './pages/Login.tsx';
import { Metrics } from './pages/Metrics.tsx';
import { OrgDesigner } from './pages/OrgDesigner.tsx';
import { OrgSettings } from './pages/OrgSettings.tsx';
import { Phase } from './pages/Phase.tsx';
import { ProjectSettings } from './pages/ProjectSettings.tsx';
import { Projects } from './pages/Projects.tsx';
import { PlatformAudit } from './pages/platform/PlatformAudit.tsx';
import { PlatformInvitations } from './pages/platform/PlatformInvitations.tsx';
import { PlatformOrgDetail } from './pages/platform/PlatformOrgDetail.tsx';
import { PlatformOrgs } from './pages/platform/PlatformOrgs.tsx';
import { PlatformUsers } from './pages/platform/PlatformUsers.tsx';
import { ResearchTab } from './pages/ResearchTab.tsx';
import { Schedules } from './pages/Schedules.tsx';
import { Settings } from './pages/Settings.tsx';
import { Vaults } from './pages/Vaults.tsx';
import { Workstations } from './pages/Workstations.tsx';

function Home() {
  const projects = useProjects();
  if (projects.isPending) return <PageSkeleton label="Loading" />;
  const last = getLastProjectKey();
  const key = projects.data?.find((p) => p.key === last)?.key ?? projects.data?.[0]?.key;
  return <Navigate to={key ? `/p/${key}/board` : '/projects'} replace />;
}

export const routes = [
  { path: '/login', element: <Login />, errorElement: <RouteError /> },
  { path: '/invite/:token', element: <AcceptInvite />, errorElement: <RouteError /> },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/p/:projectKey/board', element: <Board /> },
      { path: '/p/:projectKey/feed', element: <FeedProject /> },
      { path: '/p/:projectKey/research', element: <ResearchTab /> },
      { path: '/p/:projectKey/phases/:number', element: <Phase /> },
      { path: '/schedules', element: <Schedules /> },
      { path: '/interests', element: <Interests /> },
      { path: '/cards/new', element: <CardNew /> },
      { path: '/cards/:ref', element: <CardDetail /> },
      { path: '/projects', element: <Projects /> },
      { path: '/projects/:id/settings', element: <ProjectSettings /> },
      { path: '/agents', element: <Agents /> },
      { path: '/hr', element: <Agents /> },
      { path: '/metrics', element: <Metrics /> },
      { path: '/org', element: <OrgDesigner /> },
      { path: '/workstations', element: <Workstations /> },
      { path: '/settings', element: <Settings /> },
      { path: '/settings/vaults', element: <Vaults /> },
      { path: '/settings/org', element: <OrgSettings /> },
      { path: '/admin', element: <Navigate to="/settings/org" replace /> },
      { path: '/desk', element: <Desk /> },
      { path: '/ledger', element: <Ledger /> },
      { path: '/chat/:threadId', element: <Chat /> },
      { path: '/intake', element: <IntakeNew /> },
      { path: '/intake/:id', element: <IntakeView /> },
    ],
  },
  {
    element: <RequireAuth platform />,
    errorElement: <RouteError />,
    children: [
      {
        element: <PlatformShell />,
        children: [
          { path: '/platform', element: <PlatformOrgs /> },
          { path: '/platform/orgs/:id', element: <PlatformOrgDetail /> },
          { path: '/platform/invitations', element: <PlatformInvitations /> },
          { path: '/platform/users', element: <PlatformUsers /> },
          { path: '/platform/audit', element: <PlatformAudit /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export const createRouter = () => createBrowserRouter(routes);
