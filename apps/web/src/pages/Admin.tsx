import { UserRole } from '@aom/shared';
import { MailPlus, Server, Users } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Navigate } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import {
  useAdminInvitations,
  useAdminMutations,
  useAdminUsers,
  useAdminWorkstations,
} from '../api/queries/workstations.ts';
import {
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  Select,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { formatDateTime } from '../lib/time.ts';
import { WorkstationCard } from './Workstations.tsx';

export function Admin() {
  const me = useMe();
  const users = useAdminUsers();
  const invitations = useAdminInvitations();
  const stations = useAdminWorkstations();
  const m = useAdminMutations();
  const toast = useToast();
  const [revoking, setRevoking] = useState<{ id: string; email: string } | null>(null);
  const [deactivating, setDeactivating] = useState<{ id: string; email: string; name: string } | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [emailErr, setEmailErr] = useState('');

  if (me.data && !me.data.isAdmin) return <Navigate to="/" replace />;

  const invite = (e: FormEvent) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setEmailErr('Enter a valid email address');
    setEmailErr('');
    m.invite.mutate(
      { email: email.trim(), role },
      {
        onSuccess: () => {
          toast.success(`Invitation sent to ${email.trim()}`);
          setEmail('');
        },
      },
    );
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <PageHeader title="Admin" sub="People, invitations and every workstation in the organization." />
      <Panel title="Invite a user">
        <form
          onSubmit={invite}
          noValidate
          aria-label="Invite user"
          className="grid items-end gap-4 sm:grid-cols-[1fr_10rem_auto]"
        >
          <TextInput
            label="Email"
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailErr}
          />
          <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
            {UserRole.options.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="primary" loading={m.invite.isPending}>
            Send invitation
          </Button>
        </form>
        <div className="mt-2">
          <ErrorBox error={m.invite.error} />
        </div>
      </Panel>

      <Panel title="Invitations" padding="none">
        {invitations.isPending && (
          <div className="p-4">
            <ListSkeleton label="Loading invitations" rows={2} />
          </div>
        )}
        {invitations.data?.length === 0 && (
          <EmptyState
            bare
            icon={MailPlus}
            title="No invitations yet"
            description="Invite someone above. They get an email with a link to create their account."
          />
        )}
        <ul className="divide-y divide-line text-sm" data-testid="invitations">
          {invitations.data?.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-fg">
                <span className="font-medium break-all">{i.email}</span>
                <Badge>{i.role}</Badge>
                <Badge
                  tone={i.status === 'pending' ? 'amber' : i.status === 'accepted' ? 'green' : 'neutral'}
                >
                  {i.status}
                </Badge>
                <span className="text-xs text-subtle">expires {formatDateTime(i.expiresAt)}</span>
              </span>
              {i.status === 'pending' && (
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Resend invitation to ${i.email}`}
                    onClick={() =>
                      m.resend.mutate(i.id, {
                        onSuccess: () => toast.success(`Invitation resent to ${i.email}`),
                      })
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
          <ErrorBox error={m.resend.error ?? m.revoke.error} />
        </div>
      </Panel>

      <Panel title="Users" padding="none">
        {users.isPending && (
          <div className="p-4">
            <ListSkeleton label="Loading users" rows={3} />
          </div>
        )}
        {users.data?.length === 0 && <EmptyState bare icon={Users} title="No users" />}
        <ul className="divide-y divide-line text-sm" data-testid="users">
          {users.data?.map((u) => {
            const self = u.id === me.data?.user.id;
            return (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="flex min-w-0 items-center gap-3">
                  <Avatar name={u.displayName} size={32} />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2 font-medium text-fg">
                      {u.displayName}
                      {u.status === 'deactivated' && <Badge tone="red">deactivated</Badge>}
                      {self && <Badge tone="blue">you</Badge>}
                    </span>
                    <span className="block truncate text-xs text-subtle">{u.email}</span>
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <label className="sr-only" htmlFor={`role-${u.id}`}>
                    Role for {u.email}
                  </label>
                  <select
                    id={`role-${u.id}`}
                    value={u.role}
                    disabled={self}
                    onChange={(e) =>
                      m.patchUser.mutate(
                        { id: u.id, body: { role: e.target.value as 'admin' | 'member' } },
                        { onSuccess: () => toast.success(`${u.displayName} is now ${e.target.value}`) },
                      )
                    }
                    className="h-9 rounded-control border border-control bg-surface px-2 text-sm text-fg disabled:bg-sunken disabled:text-disabled-fg"
                  >
                    {UserRole.options.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant={u.status === 'active' ? 'danger-ghost' : 'secondary'}
                    disabled={self}
                    aria-label={`${u.status === 'active' ? 'Deactivate' : 'Reactivate'} ${u.email}`}
                    onClick={() =>
                      u.status === 'active'
                        ? setDeactivating({ id: u.id, email: u.email, name: u.displayName })
                        : m.patchUser.mutate(
                            { id: u.id, body: { status: 'active' } },
                            { onSuccess: () => toast.success(`${u.displayName} reactivated`) },
                          )
                    }
                  >
                    {u.status === 'active' ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
        <div className="px-4 pb-3 empty:hidden">
          <ErrorBox error={m.patchUser.error} />
        </div>
      </Panel>

      <section aria-label="All workstations">
        <h2 className="mb-3 text-lg font-semibold text-fg">All workstations</h2>
        {stations.isPending && <ListSkeleton label="Loading workstations" rows={2} />}
        {stations.data?.filter((w) => w.status === 'active').length === 0 && (
          <EmptyState
            icon={Server}
            title="No workstations paired"
            description="Nobody has paired a machine yet."
          />
        )}
        <ul className="flex flex-col gap-3">
          {stations.data
            ?.filter((w) => w.status === 'active')
            .map((w) => (
              <WorkstationCard key={w.id} w={w} admin />
            ))}
        </ul>
      </section>

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke the invitation to ${revoking?.email ?? ''}?`}
        description="The link in their email stops working. You can invite them again later."
        confirmLabel="Revoke invitation"
        pending={m.revoke.isPending}
        onConfirm={() =>
          revoking &&
          m.revoke.mutate(revoking.id, {
            onSuccess: () => {
              toast.success('Invitation revoked');
              setRevoking(null);
            },
            onError: () => setRevoking(null),
          })
        }
      />
      <ConfirmDialog
        open={!!deactivating}
        onOpenChange={(o) => !o && setDeactivating(null)}
        title={`Deactivate ${deactivating?.name ?? ''}?`}
        description={`${deactivating?.email ?? ''} is signed out. Their workstations are unlinked and their agents are parked until a manager re-homes them. Their cards and history are kept.`}
        confirmLabel="Deactivate user"
        pending={m.patchUser.isPending}
        onConfirm={() =>
          deactivating &&
          m.patchUser.mutate(
            { id: deactivating.id, body: { status: 'deactivated' } },
            {
              onSuccess: () => {
                toast.success(`${deactivating.name} deactivated`);
                setDeactivating(null);
              },
              onError: () => setDeactivating(null),
            },
          )
        }
      />
    </div>
  );
}
