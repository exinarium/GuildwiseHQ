import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { useSetTimezone } from '../api/queries/reporting.ts';
import { browserTimeZone } from '../lib/timezone.ts';
import { getSocket, useSocketState } from '../ws/socket.ts';
import { AppShell } from './shell/AppShell.tsx';
import { PageSkeleton } from './ui.tsx';

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
  return <AppShell isAdmin={me.data.isAdmin} name={me.data.user.displayName} live={socketState} />;
}
