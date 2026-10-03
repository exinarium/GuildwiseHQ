import { createBrowserRouter, Navigate } from 'react-router';
import { useProjects } from './api/queries/projects.ts';
import { RequireAuth } from './components/Layout.tsx';
import { Spinner } from './components/ui.tsx';
import { getLastProjectKey } from './lib/lastProject.ts';
import { AcceptInvite } from './pages/AcceptInvite.tsx';
import { Admin } from './pages/Admin.tsx';
import { Agents } from './pages/Agents.tsx';
import { Board } from './pages/Board.tsx';
import { CardDetail } from './pages/CardDetail.tsx';
import { CardNew } from './pages/CardNew.tsx';
import { Login } from './pages/Login.tsx';
import { ProjectSettings } from './pages/ProjectSettings.tsx';
import { Projects } from './pages/Projects.tsx';
import { Vaults } from './pages/Vaults.tsx';
import { Workstations } from './pages/Workstations.tsx';

function Home() {
  const projects = useProjects();
  if (projects.isPending) return <Spinner />;
  const last = getLastProjectKey();
  const key = projects.data?.find((p) => p.key === last)?.key ?? projects.data?.[0]?.key;
  return <Navigate to={key ? `/p/${key}/board` : '/projects'} replace />;
}

export const routes = [
  { path: '/login', element: <Login /> },
  { path: '/invite/:token', element: <AcceptInvite /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/p/:projectKey/board', element: <Board /> },
      { path: '/cards/new', element: <CardNew /> },
      { path: '/cards/:ref', element: <CardDetail /> },
      { path: '/projects', element: <Projects /> },
      { path: '/projects/:id/settings', element: <ProjectSettings /> },
      { path: '/agents', element: <Agents /> },
      { path: '/workstations', element: <Workstations /> },
      { path: '/settings/vaults', element: <Vaults /> },
      { path: '/admin', element: <Admin /> },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export const createRouter = () => createBrowserRouter(routes);
