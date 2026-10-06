import { useEffect } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useLogout, useMe } from '../api/queries/auth.ts';
import { useDesk } from '../api/queries/desk.ts';
import { useProjects } from '../api/queries/projects.ts';
import { useSetTimezone } from '../api/queries/reporting.ts';
import { getLastProjectKey } from '../lib/lastProject.ts';
import { browserTimeZone } from '../lib/timezone.ts';
import { getSocket, useSocketState } from '../ws/socket.ts';
import { INTERESTS_NAV } from './nav.ts';
import { Avatar, Spinner } from './ui.tsx';

const link = ({ isActive }: { isActive: boolean }) =>
  `whitespace-nowrap rounded-control px-2.5 py-1.5 text-sm font-medium ${
    isActive ? 'bg-sunken text-fg  dark:text-white' : 'text-muted hover:bg-sunken  '
  }`;

export function RequireAuth() {
  const me = useMe();
  const loc = useLocation();
  const socketState = useSocketState();
  useEffect(() => {
    if (me.data) getSocket()?.start();
    else getSocket()?.stop();
  }, [me.data]);
  // First login: take the manager's time zone from the browser (the daily BA report is posted on their clock).
  const setZone = useSetTimezone();
  const needsZone = !!me.data && !me.data.user.timezone;
  const detected = needsZone ? browserTimeZone() : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per session when the zone is unset
  useEffect(() => {
    if (detected) setZone.mutate(detected);
  }, [detected]);
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
  const desk = useDesk();
  const open = desk.data?.counts.open ?? 0;
  const key = getLastProjectKey() ?? projects.data?.[0]?.key;
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="hidden text-sm font-semibold tracking-tight sm:block">Agent Org</span>
          <nav aria-label="Main" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <NavLink to={key ? `/p/${key}/board` : '/projects'} className={link}>
              Board
            </NavLink>
            <NavLink to="/desk" className={link}>
              Desk
              {open > 0 && (
                <span
                  data-testid="desk-badge"
                  title={`${desk.data?.counts.blocking ?? 0} blocking, ${open} open`}
                  className="ml-1.5 rounded-full bg-danger-fill px-1.5 text-xs font-semibold text-white"
                >
                  {open}
                </span>
              )}
            </NavLink>
            <NavLink to="/ledger" className={link}>
              Ledger
            </NavLink>
            <NavLink to="/cards/new" className={link}>
              New card
            </NavLink>
            <NavLink to="/agents" className={link}>
              HR
            </NavLink>
            <NavLink to="/org" className={link}>
              Organization
            </NavLink>
            <NavLink to="/metrics" className={link}>
              Metrics
            </NavLink>
            <NavLink to="/workstations" className={link}>
              Workstations
            </NavLink>
            <NavLink to="/projects" className={link}>
              Projects
            </NavLink>
            <NavLink to="/schedules" className={link}>
              Schedules
            </NavLink>
            <NavLink to={INTERESTS_NAV.to} data-testid={INTERESTS_NAV.testId} className={link}>
              {INTERESTS_NAV.label}
            </NavLink>
            <NavLink to="/settings/vaults" className={link}>
              Vaults
            </NavLink>
            <NavLink to="/settings" end className={link}>
              Settings
            </NavLink>
            {isAdmin && (
              <NavLink to="/admin" className={link}>
                Admin
              </NavLink>
            )}
          </nav>
          <span
            className="hidden items-center gap-1 text-xs text-subtle sm:flex"
            title={`Live updates: ${live}`}
            data-testid="live-indicator"
            data-state={live}
          >
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${live === 'open' ? 'bg-success-fill' : 'bg-subtle'}`}
            />
            {live === 'open' ? 'Live' : 'Offline'}
          </span>
          <Avatar name={name} size={26} />
          <button
            type="button"
            onClick={() => logout.mutate()}
            className="rounded-control px-2 py-1 text-sm text-muted hover:bg-sunken"
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
