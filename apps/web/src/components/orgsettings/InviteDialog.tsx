import type { ProjectDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useInviteMember } from '../../api/queries/orgs.ts';
import { Button, Dialog, ErrorBox, Field, TextInput, useToast } from '../ui.tsx';

/** Invite someone to the organization as a Member (with the projects they start on) or, for the Owner, as an Admin. */
export function InviteDialog({
  open,
  onOpenChange,
  canInviteAdmin,
  projects,
  used,
  max,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  canInviteAdmin: boolean;
  projects: ProjectDto[];
  used: number | undefined;
  max: number | null;
}) {
  const invite = useInviteMember();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setErr('Enter a valid email address');
    setErr('');
    invite.mutate(
      { email: email.trim(), role, projectIds: role === 'member' ? picked : [] },
      {
        onSuccess: () => {
          toast.success(`Invitation sent to ${email.trim()}`);
          setEmail('');
          setPicked([]);
          onOpenChange(false);
        },
      },
    );
  };
  const after = used !== undefined ? used + 1 : null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invite a member"
      description="They get an email with a link to join. People who do not have an account yet create one."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="invite-member-form" variant="primary" loading={invite.isPending}>
            Send invitation
          </Button>
        </>
      }
    >
      <form
        id="invite-member-form"
        onSubmit={submit}
        noValidate
        className="space-y-4"
        aria-label="Invite member"
      >
        <TextInput
          label="Email"
          type="email"
          placeholder="name@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={err}
        />
        <Field label="Role" htmlFor="invite-role">
          <div role="radiogroup" aria-label="Role" className="flex gap-4 text-sm text-fg">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="role"
                checked={role === 'member'}
                onChange={() => setRole('member')}
              />
              Member
            </label>
            <label className={`flex items-center gap-2 ${canInviteAdmin ? '' : 'opacity-50'}`}>
              <input
                type="radio"
                name="role"
                disabled={!canInviteAdmin}
                checked={role === 'admin'}
                onChange={() => setRole('admin')}
              />
              Admin
              {!canInviteAdmin && <span className="text-xs text-subtle">(Owner only)</span>}
            </label>
          </div>
        </Field>
        {role === 'member' && projects.length > 0 && (
          <Field
            label="Projects"
            htmlFor="invite-projects"
            hint="They can work in these from the start. You can change this later."
          >
            <ul
              className="max-h-40 space-y-1 overflow-y-auto rounded-control border border-line p-2"
              id="invite-projects"
            >
              {projects.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-8 items-center gap-2.5 text-sm text-fg">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={picked.includes(p.id)}
                      onChange={(e) =>
                        setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))
                      }
                    />
                    <span className="rounded-[6px] bg-neutral-soft px-1.5 font-mono text-xs font-semibold text-neutral-soft-fg">
                      {p.key}
                    </span>
                    {p.name}
                  </label>
                </li>
              ))}
            </ul>
          </Field>
        )}
        {max !== null && after !== null && (
          <p className="text-xs text-subtle">
            {after} of {max} seats used after this invitation.
          </p>
        )}
        <ErrorBox error={invite.error} />
      </form>
    </Dialog>
  );
}
