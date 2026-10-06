import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { useSetTimezone } from '../api/queries/reporting.ts';
import { browserTimeZone } from '../lib/timezone.ts';
import { SecuritySetup } from '../pages/SecuritySetup.tsx';
import { getSocket, useSocketState } from '../ws/socket.ts';
import { AppShell } from './shell/AppShell.tsx';
import { PageSkeleton } from './ui.tsx';

/** The signed-in frame. `platform` is the platform administrator's area; everyone else gets the work shell. */
export function RequireAuth({ platform = false }: { platform?: boolean } = {}) {
  const me = useMe();
  const loc = useLocation();
  const socketState = useSocketState();
  useEffect(() => {
    // No live socket while two-factor setup is pending (the server refuses it) or for a platform account's login page.
    if (me.data && !me.data.twoFactor.setupRequired) getSocket()?.start();
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
  if (me.isPending)
    return (
      <div className="mx-auto max-w-3xl p-6">
        <PageSkeleton label="Loading session" />
      </div>
    );
  if (!me.data) {
    const next = loc.pathname + loc.search;
    return <Navigate to={`/login${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`} replace />;
  }
  // An account that must have two-factor login sets it up first; a platform account never reaches the work shell.
  if (me.data.twoFactor.setupRequired) return <SecuritySetup me={me.data} />;
  const isPlatform = me.data.account.kind === 'super_admin';
  if (platform) return isPlatform ? <Outlet /> : <Navigate to="/" replace />;
  if (isPlatform) return <Navigate to="/platform" replace />;
  return <AppShell name={me.data.user.displayName} live={socketState} />;
}
