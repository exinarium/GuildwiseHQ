import type { MeResponse } from '@aom/shared';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { meKey, useLogout, useTwoFactorStatus } from '../api/queries/auth.ts';
import { AuthFrame } from '../components/auth/AuthFrame.tsx';
import { TwoFactorSetup } from '../components/security/TwoFactorPanel.tsx';
import { Button, Callout } from '../components/ui.tsx';
import { usePageTitle } from '../lib/usePageTitle.ts';

/**
 * Shown instead of the app when the account must have two-factor login and has not set it up yet (a super admin at
 * their first sign-in, or a member of an organization that requires it). Nothing else is reachable until it is on.
 */
export function SecuritySetup({ me }: { me: MeResponse }) {
  usePageTitle('Set up two-factor login');
  const status = useTwoFactorStatus();
  const logout = useLogout();
  const qc = useQueryClient();
  const why =
    me.account.kind === 'super_admin'
      ? 'Platform accounts must sign in with two-factor login.'
      : status.data?.requiredBy.length
        ? `${status.data.requiredBy.map((o) => o.name).join(', ')} requires two-factor login of every member.`
        : 'Your organization requires two-factor login.';
  return (
    <AuthFrame>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Secure your account</h1>
        <p className="mt-1.5 text-base text-muted">Set up two-factor login to continue.</p>
      </div>
      <Callout tone="info" className="mb-5" role="status">
        {why}
      </Callout>
      <TwoFactorSetup onFinished={() => void qc.invalidateQueries({ queryKey: meKey })} />
      <div className="mt-8 border-t border-line pt-4">
        <Button variant="ghost" onClick={() => logout.mutate()}>
          <LogOut aria-hidden="true" className="size-4" />
          Sign out
        </Button>
      </div>
    </AuthFrame>
  );
}
