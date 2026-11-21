import type { TwoFactorRecoveryState } from '@aom/shared';
import { ShieldAlert } from 'lucide-react';
import { useTwoFactorRecoveryAction, useTwoFactorRecoveryStatus } from '../api/queries/leastPrivilege.ts';
import { AuthFrame } from '../components/auth/AuthFrame.tsx';
import { Button, ButtonLink, Callout, EmptyState, ErrorBox, Skeleton } from '../components/ui.tsx';
import { formatDateTime } from '../lib/time.ts';
import { usePageTitle } from '../lib/usePageTitle.ts';

const DONE_TEXT: Partial<Record<TwoFactorRecoveryState, { title: string; description: string }>> = {
  done: {
    title: 'Two-factor login was removed',
    description: 'Sign in with your password and set up a new authenticator.',
  },
  cancelled: {
    title: 'This recovery was cancelled',
    description:
      'Your two-factor login stays as it is. Start a new recovery from the sign-in page if you need one.',
  },
  expired: {
    title: 'This link has expired',
    description: 'Start a new recovery from the two-factor step of the sign-in page.',
  },
};

/**
 * `/recover-2fa#<token>`: the mailed "Lost your authenticator?" link (R17-2). The token stays in the fragment, so it
 * never reaches the server in a URL. Confirm starts the 24-hour wait; cancel stops it. Not signed in.
 */
export function RecoverTwoFactor() {
  usePageTitle('Two-factor recovery');
  const token = typeof window === 'undefined' ? '' : window.location.hash.replace(/^#/, '');
  const status = useTwoFactorRecoveryStatus(token);
  const act = useTwoFactorRecoveryAction(token);

  if (token && status.isPending)
    return (
      <AuthFrame>
        <div role="status" aria-live="polite" className="space-y-4">
          <span className="sr-only">Checking the link...</span>
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-11 w-full" />
        </div>
      </AuthFrame>
    );

  const s = status.data;
  const done = s ? DONE_TEXT[s.state] : undefined;
  if (!token || status.isError || done)
    return (
      <AuthFrame>
        <EmptyState
          bare
          icon={ShieldAlert}
          tone="warning"
          title={done?.title ?? 'This link is not valid'}
          description={
            done?.description ??
            'Open the link from the latest recovery mail, or start again from the sign-in page.'
          }
          action={
            <ButtonLink to="/login" variant="secondary">
              Go to sign in
            </ButtonLink>
          }
        />
      </AuthFrame>
    );

  return (
    <AuthFrame>
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Two-factor recovery</h1>
        <p className="mt-1.5 text-base text-muted">
          {s?.state === 'waiting'
            ? 'Your two-factor login is being removed.'
            : 'Remove the two-factor login of your account because your authenticator is lost.'}
        </p>
      </div>
      <div className="flex flex-col gap-4" data-testid="recover-2fa">
        {s?.state === 'waiting' && s.effectiveAt ? (
          <Callout tone="warning" title="Waiting 24 hours for your safety">
            Two-factor login is removed {formatDateTime(s.effectiveAt)}. The Owners of your organizations were
            told. Signing in with a code or a recovery code cancels it. If this was not you, cancel it and
            change your password.
          </Callout>
        ) : (
          <Callout tone="info">
            When you confirm, two-factor login is removed 24 hours later and the Owners of your organizations
            are told. If you find your authenticator before then, just sign in with it: that cancels the
            recovery.
          </Callout>
        )}
        {s?.state === 'awaiting_confirmation' && (
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={act.isPending && act.variables === 'confirm'}
            onClick={() => act.mutate('confirm')}
            data-testid="recover-2fa-confirm"
          >
            Confirm the recovery
          </Button>
        )}
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          loading={act.isPending && act.variables === 'cancel'}
          onClick={() => act.mutate('cancel')}
          data-testid="recover-2fa-cancel"
        >
          {s?.state === 'waiting' ? 'Cancel: this was not me' : 'Cancel'}
        </Button>
        <ErrorBox error={act.error} />
      </div>
    </AuthFrame>
  );
}
