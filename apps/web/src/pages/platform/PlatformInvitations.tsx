import { MailPlus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  useInviteNewOrg,
  usePlatformInvitationAction,
  usePlatformInvitations,
} from '../../api/queries/platform.ts';
import {
  Badge,
  Button,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  TextInput,
  useToast,
} from '../../components/ui.tsx';
import { formatDateTime } from '../../lib/time.ts';

/** `/platform/invitations`: invite someone to start a new organization (plan Founding, no limits for now). */
export function PlatformInvitations() {
  const list = usePlatformInvitations();
  const invite = useInviteNewOrg();
  const action = usePlatformInvitationAction();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [orgName, setOrgName] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate(
      { email: email.trim(), proposedOrgName: orgName.trim(), plan: 'founding', status: 'active' },
      {
        onSuccess: () => {
          toast.success(`Invitation sent to ${email.trim()}`);
          setEmail('');
          setOrgName('');
        },
      },
    );
  };
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Invitations"
        sub="Invite someone to start a new organization. They become its Owner when they accept."
      />
      <Panel title="Invite a new organization">
        <form
          onSubmit={submit}
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          data-testid="new-org-form"
        >
          <TextInput
            label="Owner email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextInput
            label="Organization name"
            required
            maxLength={120}
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
          />
          <Button type="submit" disabled={invite.isPending || !email || !orgName.trim()}>
            Send invitation
          </Button>
        </form>
        {invite.isError && (
          <div className="mt-3">
            <ErrorBox error={invite.error} />
          </div>
        )}
      </Panel>
      <Panel title="All invitations" padding="none">
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
            description="New-organization invitations show up here."
          />
        )}
        <ul className="divide-y divide-line text-sm" data-testid="platform-invitations">
          {list.data?.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="font-medium break-all text-fg">{i.email}</span>
                {i.proposedOrgName && <span className="text-muted">for {i.proposedOrgName}</span>}
                <Badge
                  tone={i.status === 'pending' ? 'amber' : i.status === 'accepted' ? 'green' : 'neutral'}
                >
                  {i.status}
                </Badge>
                <span className="text-xs text-subtle">
                  {i.status === 'pending'
                    ? `expires ${formatDateTime(i.expiresAt)}`
                    : formatDateTime(i.acceptedAt ?? i.createdAt)}
                </span>
              </span>
              {i.status === 'pending' && (
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Resend invitation to ${i.email}`}
                    onClick={() =>
                      action.mutate(
                        { id: i.id, action: 'resend' },
                        { onSuccess: () => toast.success('Invitation resent') },
                      )
                    }
                  >
                    Resend
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    aria-label={`Revoke invitation to ${i.email}`}
                    onClick={() => action.mutate({ id: i.id, action: 'revoke' })}
                  >
                    Revoke
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
