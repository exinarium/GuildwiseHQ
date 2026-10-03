import type { ProjectDetailResponse } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useRemovalPreview, useRemoveMember, useShareProject } from '../api/queries/members.ts';
import { Badge, Button, Dialog, ErrorBox, Panel, Spinner, TextInput } from './ui.tsx';

type Member = ProjectDetailResponse['members'][number];

/** Project Members tab: invite by email (the invitee must accept), pending shares, removal with an inheritance preview. */
export function MembersPanel({
  projectId,
  members,
  isOwner,
}: {
  projectId: string;
  members: Member[];
  isOwner: boolean;
}) {
  const share = useShareProject(projectId);
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const [removing, setRemoving] = useState<Member | null>(null);

  const invite = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setErr('Enter the email of an existing user');
    setErr(undefined);
    share.mutate(email.trim(), { onSuccess: () => setEmail('') });
  };

  return (
    <Panel>
      <h2 className="mb-2 text-sm font-semibold">Members</h2>
      <p className="mb-2 text-xs text-zinc-500">
        Invited users join this project as additional managers once they accept: they see its board and desk
        and can hire agents for it onto their own workstations. Everything else of theirs stays private.
      </p>
      <ul className="flex flex-col gap-1.5 text-sm" data-testid="members">
        {members.map((m) => (
          <li
            key={m.userId}
            data-testid={`member-${m.email}`}
            data-status={m.status}
            className="flex flex-wrap items-center gap-2"
          >
            <span>
              {m.displayName} <span className="text-zinc-500">({m.email})</span>
            </span>
            <Badge>{m.role}</Badge>
            {m.status === 'invited' && <Badge tone="amber">pending</Badge>}
            {isOwner && m.role !== 'owner' && (
              <Button
                variant="ghost"
                aria-label={`${m.status === 'invited' ? 'Cancel invitation for' : 'Remove'} ${m.displayName}`}
                onClick={() => setRemoving(m)}
              >
                {m.status === 'invited' ? 'Cancel invitation' : 'Remove'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {isOwner && (
        <form
          onSubmit={invite}
          noValidate
          aria-label="Invite member"
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
        >
          <div className="flex-1">
            <TextInput
              label="Invite by email"
              type="email"
              placeholder="colleague@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={err}
            />
          </div>
          <Button type="submit" variant="primary" disabled={share.isPending}>
            Send invitation
          </Button>
        </form>
      )}
      <ErrorBox error={share.error} />
      <RemoveDialog projectId={projectId} member={removing} onClose={() => setRemoving(null)} />
    </Panel>
  );
}

function RemoveDialog({
  projectId,
  member,
  onClose,
}: {
  projectId: string;
  member: Member | null;
  onClose: () => void;
}) {
  const preview = useRemovalPreview(projectId, member?.userId ?? null);
  const remove = useRemoveMember(projectId);
  const p = preview.data;
  return (
    <Dialog
      open={!!member}
      onOpenChange={(o) => !o && onClose()}
      title={`Remove ${member?.displayName ?? ''}?`}
      description="You inherit their agents for this project and the cards they own. Agents need a new home before they work again."
    >
      {preview.isPending && <Spinner />}
      <ErrorBox error={preview.error} />
      {p && (
        <div className="flex flex-col gap-3 text-sm" data-testid="removal-preview">
          <section>
            <p className="font-medium">Agents you inherit ({p.agents.length})</p>
            {p.agents.length === 0 ? (
              <p className="text-zinc-500">None.</p>
            ) : (
              <ul className="list-disc pl-5">
                {p.agents.map((a) => (
                  <li key={a.id}>
                    {a.name}{' '}
                    <span className="text-zinc-500">
                      ({a.roleKey}
                      {a.workstationName ? ` on ${a.workstationName}` : ''})
                    </span>
                    {a.claimedCardRef && <> holds {a.claimedCardRef}</>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <p className="font-medium">Cards released to the queue ({p.releasedCards.length})</p>
            {p.releasedCards.length === 0 ? (
              <p className="text-zinc-500">None. Released cards keep their last handoff.</p>
            ) : (
              <ul className="list-disc pl-5">
                {p.releasedCards.map((c) => (
                  <li key={c.ref}>
                    {c.ref} {c.title}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <p className="font-medium">Cards that become yours ({p.transferredCards.length})</p>
            {p.transferredCards.length === 0 ? (
              <p className="text-zinc-500">None.</p>
            ) : (
              <ul className="list-disc pl-5">
                {p.transferredCards.map((c) => (
                  <li key={c.ref}>
                    {c.ref} {c.title} <span className="text-zinc-500">({c.status})</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      <ErrorBox error={remove.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="danger"
          disabled={!p || remove.isPending}
          onClick={() => member && remove.mutate(member.userId, { onSuccess: onClose })}
        >
          Confirm removal
        </Button>
      </div>
    </Dialog>
  );
}
