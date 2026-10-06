import { ORG_ROLE_LABEL } from '@aom/shared';
import { MailPlus } from 'lucide-react';
import { useState } from 'react';
import { useOrgInvitations, useResendOrgInvitation, useRevokeOrgInvitation } from '../../api/queries/orgs.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorBox, ListSkeleton, Panel, useToast } from '../ui.tsx';

/** Pending and past invitations to the organization; the Owner and Admins resend or revoke a pending one. */
export function InvitationsTab({ role }: { role: 'owner' | 'admin' }) {
  const list = useOrgInvitations();
  const resend = useResendOrgInvitation();
  const revoke = useRevokeOrgInvitation();
  const toast = useToast();
  const [revoking, setRevoking] = useState<{ id: string; email: string } | null>(null);
  return (
    <Panel title="Invitations" padding="none">
      {list.isPending && (
        <div className="p-4">
          <ListSkeleton label="Loading invitations" rows={2} />
        </div>
      )}
      {list.data?.length === 0 && (
        <EmptyState
          bare
          icon={MailPlus}
          title="No invitations yet"
          description="Invite a member from the Members tab. They get an email with a link to join."
        />
      )}
      <ul className="divide-y divide-line text-sm" data-testid="invitations">
        {list.data?.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-fg">
              <span className="font-medium break-all">{i.email}</span>
              <Badge>{ORG_ROLE_LABEL[i.orgRole]}</Badge>
              <Badge tone={i.status === 'pending' ? 'amber' : i.status === 'accepted' ? 'green' : 'neutral'}>
                {i.status}
              </Badge>
              <span className="text-xs text-subtle">
                {i.status === 'pending'
                  ? `expires ${formatDateTime(i.expiresAt)}`
                  : formatDateTime(i.acceptedAt ?? i.createdAt)}
              </span>
              {i.invitedByName && <span className="text-xs text-subtle">by {i.invitedByName}</span>}
            </span>
            {i.status === 'pending' && (role === 'owner' || i.orgRole === 'member') && (
              <span className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Resend invitation to ${i.email}`}
                  onClick={() =>
                    resend.mutate(i.id, { onSuccess: () => toast.success(`Invitation resent to ${i.email}`) })
                  }
                >
                  Resend
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  aria-label={`Revoke invitation to ${i.email}`}
                  onClick={() => setRevoking({ id: i.id, email: i.email })}
                >
                  Revoke
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="px-4 pb-3 empty:hidden">
        <ErrorBox error={resend.error ?? revoke.error} />
      </div>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke the invitation to ${revoking?.email ?? ''}?`}
        description="The link in their email stops working. You can invite them again later."
        confirmLabel="Revoke invitation"
        pending={revoke.isPending}
        onConfirm={() =>
          revoking &&
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              toast.success('Invitation revoked');
              setRevoking(null);
            },
            onError: () => setRevoking(null),
          })
        }
      />
    </Panel>
  );
}
