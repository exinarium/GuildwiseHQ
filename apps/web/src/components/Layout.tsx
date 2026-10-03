import { useEffect } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useLogout, useMe } from '../api/queries/auth.ts';
import { useProjects } from '../api/queries/projects.ts';
import { getLastProjectKey } from '../lib/lastProject.ts';
import { getSocket, useSocketState } from '../ws/socket.ts';
import { Avatar, Spinner } from './ui.tsx';

const link = ({ isActive }: { isActive: boolean }) =>
  `whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-medium ${
    isActive
      ? 'bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-white'
      : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900'
  }`;

export function RequireAuth() {
  const me = useMe();
  const loc = useLocation();
  const socketState = useSocketState();
  useEffect(() => {
    if (me.data) getSocket()?.start();
    else getSocket()?.stop();
  }, [me.data]);
  if (me.isPending) return <Spinner label="Loading session" />;
  if (!me.data) {
    const next = loc.pathname + loc.search;
    return <Navigate to={`/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`} replace />;
  }
  return <Shell isAdmin={me.data.isAdmin} name={me.data.user.displayName} live={socketState} />;
}

function Shell({ isAdmin, name, live }: { isAdmin: boolean; name: string; live: string }) {
  const logout = useLogout();
  const projects = useProjects();
  const key = getLastProjectKey() ?? projects.data?.[0]?.key;
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/90 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="hidden text-sm font-semibold tracking-tight sm:block">Agent Org</span>
          <nav aria-label="Main" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <NavLink to={key ? `/p/${key}/board` : '/projects'} className={link}>
              Board
            </NavLink>
            <NavLink to="/cards/new" className={link}>
              New card
            </NavLink>
            <NavLink to="/agents" className={link}>
              Agents
            </NavLink>
            <NavLink to="/workstations" className={link}>
              Workstations
            </NavLink>
            <NavLink to="/projects" className={link}>
              Projects
            </NavLink>
            <NavLink to="/settings/vaults" className={link}>
              Vaults
            </NavLink>
            {isAdmin && (
              <NavLink to="/admin" className={link}>
                Admin
              </NavLink>
            )}
          </nav>
          <span
            className="hidden items-center gap-1 text-xs text-zinc-500 sm:flex"
            title={`Live updates: ${live}`}
            data-testid="live-indicator"
            data-state={live}
          >
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${live === 'open' ? 'bg-emerald-500' : 'bg-zinc-400'}`}
            />
            {live === 'open' ? 'Live' : 'Offline'}
          </span>
          <Avatar name={name} size={26} />
          <button
            type="button"
            onClick={() => logout.mutate()}
            className="rounded-md px-2 py-1 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 p-3 sm:p-4">
        <Outlet />
      </main>
    </div>
  );
}
