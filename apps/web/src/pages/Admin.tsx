import { UserRole } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Navigate } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import {
  useAdminInvitations,
  useAdminMutations,
  useAdminUsers,
  useAdminWorkstations,
} from '../api/queries/workstations.ts';
import { Badge, Button, ErrorBox, PageHeader, Panel, Select, Spinner, TextInput } from '../components/ui.tsx';
import { formatDateTime } from '../lib/time.ts';
import { WorkstationCard } from './Workstations.tsx';

export function Admin() {
  const me = useMe();
  const users = useAdminUsers();
  const invitations = useAdminInvitations();
  const stations = useAdminWorkstations();
  const m = useAdminMutations();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [emailErr, setEmailErr] = useState('');

  if (me.data && !me.data.isAdmin) return <Navigate to="/" replace />;

  const invite = (e: FormEvent) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setEmailErr('Enter a valid email address');
    setEmailErr('');
    m.invite.mutate({ email: email.trim(), role }, { onSuccess: () => setEmail('') });
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader title="Admin" />
      <Panel>
        <h2 className="mb-2 text-sm font-semibold">Invite a user</h2>
        <form
          onSubmit={invite}
          noValidate
          aria-label="Invite user"
          className="grid items-end gap-3 sm:grid-cols-[1fr_10rem_auto]"
        >
          <TextInput
            label="Email"
            type="email"
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
          <Button type="submit" variant="primary" disabled={m.invite.isPending}>
            Send invitation
          </Button>
        </form>
        <div className="mt-2">
          <ErrorBox error={m.invite.error} />
        </div>
      </Panel>

      <Panel>
        <h2 className="mb-2 text-sm font-semibold">Invitations</h2>
        {invitations.isPending && <Spinner />}
        <ul className="flex flex-col gap-1.5 text-sm" data-testid="invitations">
          {invitations.data?.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {i.email} <Badge>{i.role}</Badge>{' '}
                <Badge
                  tone={i.status === 'pending' ? 'amber' : i.status === 'accepted' ? 'green' : 'neutral'}
                >
                  {i.status}
                </Badge>
                <span className="ml-2 text-xs text-zinc-500">expires {formatDateTime(i.expiresAt)}</span>
              </span>
              {i.status === 'pending' && (
                <span className="flex gap-1">
                  <Button
                    variant="ghost"
                    aria-label={`Resend invitation to ${i.email}`}
                    onClick={() => m.resend.mutate(i.id)}
                  >
                    Resend
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Revoke invitation to ${i.email}`}
                    onClick={() => m.revoke.mutate(i.id)}
                  >
                    Revoke
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
        <ErrorBox error={m.resend.error ?? m.revoke.error} />
      </Panel>

      <Panel>
        <h2 className="mb-2 text-sm font-semibold">Users</h2>
        {users.isPending && <Spinner />}
        <ul className="flex flex-col gap-2 text-sm" data-testid="users">
          {users.data?.map((u) => {
            const self = u.id === me.data?.user.id;
            return (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {u.displayName} <span className="text-zinc-500">({u.email})</span>{' '}
                  {u.status === 'deactivated' && <Badge tone="red">deactivated</Badge>}
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
                      m.patchUser.mutate({ id: u.id, body: { role: e.target.value as 'admin' | 'member' } })
                    }
                    className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  >
                    {UserRole.options.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <Button
                    disabled={self}
                    aria-label={`${u.status === 'active' ? 'Deactivate' : 'Reactivate'} ${u.email}`}
                    onClick={() =>
                      m.patchUser.mutate({
                        id: u.id,
                        body: { status: u.status === 'active' ? 'deactivated' : 'active' },
                      })
                    }
                  >
                    {u.status === 'active' ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
        <ErrorBox error={m.patchUser.error} />
      </Panel>

      <section aria-label="All workstations">
        <h2 className="mb-2 text-sm font-semibold">All workstations</h2>
        {stations.isPending && <Spinner />}
        <ul className="flex flex-col gap-2">
          {stations.data
            ?.filter((w) => w.status === 'active')
            .map((w) => (
              <WorkstationCard key={w.id} w={w} admin />
            ))}
        </ul>
      </section>
    </div>
  );
}
