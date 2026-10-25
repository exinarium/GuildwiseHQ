import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { useSetTimezone } from '../api/queries/reporting.ts';
import { ext } from '../extension/index.ts';
import { browserTimeZone } from '../lib/timezone.ts';
import { ChangePasswordRequired } from '../pages/ChangePasswordRequired.tsx';
import { SecuritySetup } from '../pages/SecuritySetup.tsx';
import { getSocket, useSocketState } from '../ws/socket.ts';
import { AppShell } from './shell/AppShell.tsx';
import { PageSkeleton } from './ui.tsx';

/** The signed-in frame. `platform` is the platform administrator's area; everyone else gets the work shell. */
export function RequireAuth({ platform = false }: { platform?: boolean } = {}) {
  const me = useMe();
  const loc = useLocation();
  const socketState = useSocketState();
  // Setting two-factor login up turns `setupRequired` off before the recovery codes were saved: stay on the setup page until it says it is done.
  const [holdSetup, setHoldSetup] = useState(false);
  const setupRequired = !!me.data?.twoFactor.setupRequired;
  useEffect(() => {
    if (setupRequired) setHoldSetup(true);
  }, [setupRequired]);
  useEffect(() => {
    // No live socket while two-factor setup is pending (the server refuses it) or for a platform account's login page.
    if (
      me.data &&
      !me.data.twoFactor.setupRequired &&
      !me.data.mustChangePassword &&
      !holdSetup &&
      !me.data.activeOrg?.gate
    )
      getSocket()?.start();
    else getSocket()?.stop();
  }, [me.data, holdSetup]);
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
  // After an Owner set a temporary password nothing else is reachable until the member has chosen their own.
  if (me.data.mustChangePassword) return <ChangePasswordRequired />;
  if (me.data.twoFactor.setupRequired || holdSetup)
    return <SecuritySetup me={me.data} onDone={() => setHoldSetup(false)} />;
  const isPlatform = me.data.account.kind === 'super_admin';
  if (platform) return isPlatform ? <Outlet /> : <Navigate to="/" replace />;
  if (isPlatform) return <Navigate to="/platform" replace />;
  // An Owner whose organization waits on a card (new sign-up) or was paused for payment sees one billing screen and
  // nothing else: every other address leads there, and there is no shell, tour, checklist or What's new.
  const gate = me.data.activeOrg?.gate ?? null;
  const gatePath = ext.gatePath;
  if (gate && ext.Gate && gatePath) {
    if (loc.pathname !== gatePath) return <Navigate to={`${gatePath}${loc.search}`} replace />;
    const Providers = ext.AppProviders;
    const screen = <ext.Gate gate={gate} orgName={me.data.activeOrg?.name ?? ''} />;
    return Providers ? <Providers>{screen}</Providers> : screen;
  }
  if (gatePath && loc.pathname === gatePath) return <Navigate to="/" replace />;
  return <AppShell name={me.data.user.displayName} live={socketState} />;
}
