import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useMe } from '../api/queries/auth.ts';
import { useApplyDeskAction, useDeskActionPreview } from '../api/queries/governance.ts';
import { AuthFrame } from '../components/auth/AuthFrame.tsx';
import { Button, ButtonLink, Callout, EmptyState, ErrorBox, Skeleton } from '../components/ui.tsx';
import { usePageTitle } from '../lib/usePageTitle.ts';

/**
 * `/m/desk/:token`: the page a notification button opens (docs/design/discovery-boardroom-registry.md, S-B1). The person must be
 * signed in; the page only SHOWS the action (a GET), and nothing happens until they press the button (a POST), so opening,
 * prefetching or sharing the link applies nothing. The link works once, for 15 minutes, for the person it was sent to.
 */
export function DeskActionConfirm() {
  usePageTitle('Confirm');
  const { token = '' } = useParams();
  const loc = useLocation();
  const me = useMe();
  if (me.isPending)
    return (
      <AuthFrame>
        <div role="status" aria-live="polite" className="space-y-4">
          <span className="sr-only">Loading</span>
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-11 w-full" />
        </div>
      </AuthFrame>
    );
  if (!me.data) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  return <Confirm token={token} />;
}

function Confirm({ token }: { token: string }) {
  const preview = useDeskActionPreview(token);
  const apply = useApplyDeskAction(token);
  const desk = (
    <ButtonLink to="/desk" variant="secondary">
      Open the Desk
    </ButtonLink>
  );
  if (preview.isPending)
    return (
      <AuthFrame>
        <div role="status" aria-live="polite" className="space-y-4">
          <span className="sr-only">Loading</span>
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      </AuthFrame>
    );
  if (preview.isError) {
    const e = preview.error;
    const wrongUser = e instanceof ApiError && e.status === 403;
    return (
      <AuthFrame>
        <EmptyState
          bare
          icon={ShieldAlert}
          tone="warning"
          title={wrongUser ? 'This link is for someone else' : 'This link is not valid'}
          description={
            wrongUser
              ? 'It was sent to another person. Sign out and sign in as the person it was made for, or open the Desk.'
              : 'It may be damaged. Open the Desk to decide.'
          }
          action={desk}
        />
      </AuthFrame>
    );
  }
  const p = preview.data;
  if (apply.isSuccess)
    return (
      <AuthFrame>
        <EmptyState
          bare
          icon={CheckCircle2}
          title={
            apply.data.outcome === 'rejected'
              ? 'Rejected'
              : apply.data.outcome === 'approved'
                ? 'Approved'
                : 'Answered'
          }
          description={`${apply.data.actionLabel}: done. It is on the record.`}
          action={desk}
        />
      </AuthFrame>
    );
  const done: Record<string, { title: string; text: string }> = {
    used: { title: 'Already used', text: 'This link works once. Open the Desk to see what happened.' },
    expired: { title: 'This link expired', text: 'Links last 15 minutes. Open the Desk to decide.' },
    resolved: { title: 'Already decided', text: 'Somebody decided this already. Open the Desk to see how.' },
  };
  if (p.state !== 'ready' && done[p.state])
    return (
      <AuthFrame>
        <EmptyState
          bare
          icon={ShieldAlert}
          tone="warning"
          title={done[p.state]?.title ?? ''}
          description={done[p.state]?.text ?? ''}
          action={desk}
        />
      </AuthFrame>
    );
  const reject = p.action === 'reject';
  const err = apply.error instanceof ApiError ? apply.error : null;
  return (
    <AuthFrame>
      <div className="space-y-5" data-testid="desk-action-confirm">
        <p className="text-sm text-muted">{p.orgName}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{p.title}</h1>
        {p.body && <p className="text-base text-muted">{p.body}</p>}
        <Callout tone="info">
          You are about to choose <strong>{p.actionLabel}</strong>. Nothing happens until you press the
          button.
        </Callout>
        <Button
          variant={reject ? 'danger' : 'primary'}
          className="w-full"
          loading={apply.isPending}
          onClick={() => apply.mutate()}
        >
          {p.actionLabel}
        </Button>
        {err && err.status !== 500 ? (
          <Callout tone="warning">{err.message}</Callout>
        ) : (
          <ErrorBox error={apply.error} />
        )}
        <p className="text-sm">
          <Link
            to={`/desk#desk-item-${p.deskItemId}`}
            className="font-medium text-brand-text hover:underline"
          >
            Open it in the Desk instead
          </Link>
        </p>
      </div>
    </AuthFrame>
  );
}
