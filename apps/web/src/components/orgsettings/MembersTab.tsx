import { type OffboardingReport, ORG_ROLE_LABEL, type OrgMemberDto } from '@aom/shared';
import { Copy, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import {
  useChangeMemberRole,
  useOrg,
  useOrgMembers,
  useRemovalPreview,
  useRemoveMember,
  useResetMemberPassword,
  useResetMemberTwoFactor,
  useSetMemberProjects,
} from '../../api/queries/orgs.ts';
import { useProjects } from '../../api/queries/projects.ts';
import { UserAvatar } from '../Face.tsx';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  Menu,
  MenuItem,
  MenuSeparator,
  Panel,
  Select,
  useToast,
} from '../ui.tsx';
import { InviteDialog } from './InviteDialog.tsx';
import { OffboardingChecklist, OffboardingReportDialog } from './Offboarding.tsx';

const roleTone = { owner: 'brand', admin: 'blue', member: 'neutral' } as const;

/** Members of the organization with their role, projects and two-factor state (docs/design/organizations.md 11.2). */
export function MembersTab({ me }: { me: { userId: string; role: 'owner' | 'admin' | 'member' } }) {
  const members = useOrgMembers();
  const org = useOrg();
  const projects = useProjects();
  const toast = useToast();
  const role = useChangeMemberRole();
  const reset = useResetMemberTwoFactor();
  const resetPassword = useResetMemberPassword();
  const remove = useRemoveMember();
  const setProjects = useSetMemberProjects();
  const [inviting, setInviting] = useState(false);
  const [resettingPassword, setResettingPassword] = useState<OrgMemberDto | null>(null);
  // The temporary password lives in this state only while its dialog is open (shown once, never stored).
  const [temporary, setTemporary] = useState<{ name: string; password: string } | null>(null);
  const [removing, setRemoving] = useState<OrgMemberDto | null>(null);
  const [report, setReport] = useState<OffboardingReport | null>(null);
  const [assigning, setAssigning] = useState<OrgMemberDto | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const preview = useRemovalPreview(removing?.userId ?? null);
  const manager = me.role === 'owner' || me.role === 'admin';
  const used = org.data?.usage?.members;
  const max = org.data?.limits?.maxMembers;
  const orgProjects = (projects.data ?? []).filter((p) => p.orgId === org.data?.id);
  const canTouch = (m: OrgMemberDto) =>
    m.role !== 'owner' && m.userId !== me.userId && (me.role === 'owner' || m.role === 'member');

  // Owners reset Members and Admins; Admins reset Members only; nobody resets themselves this way.
  const canResetPassword = (m: OrgMemberDto) =>
    m.userId !== me.userId && (me.role === 'owner' ? m.role !== 'owner' : m.role === 'member');

  return (
    <Panel
      title={
        <span className="flex flex-wrap items-baseline gap-2">
          Members
          {used !== undefined && (
            <span className="text-sm font-normal text-subtle" data-testid="member-seats">
              {used} {max != null ? `of ${max}` : 'in use'}
            </span>
          )}
        </span>
      }
      actions={
        manager && (
          <Button variant="primary" onClick={() => setInviting(true)} data-testid="invite-member">
            <UserPlus aria-hidden="true" className="size-4" />
            Invite member
          </Button>
        )
      }
      padding="none"
    >
      {members.isPending && (
        <div className="p-4">
          <ListSkeleton label="Loading members" rows={3} />
        </div>
      )}
      {members.data?.length === 0 && <EmptyState bare icon={Users} title="No members" />}
      <ul className="divide-y divide-line" data-testid="members">
        {members.data?.map((m) => (
          <li key={m.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <UserAvatar
              user={{ id: m.userId, displayName: m.displayName, avatar: m.avatar ?? null }}
              size={36}
            />
            <div className="min-w-[10rem] flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
                {m.displayName}
                {m.userId === me.userId && <Badge tone="blue">you</Badge>}
              </p>
              <p className="truncate text-xs text-subtle">{m.email}</p>
            </div>
            <div className="w-28">
              {me.role === 'owner' && m.role !== 'owner' && m.userId !== me.userId ? (
                <Select
                  label={`Role of ${m.displayName}`}
                  className="h-9 py-0"
                  value={m.role}
                  onChange={(e) =>
                    role.mutate(
                      { userId: m.userId, role: e.target.value as 'admin' | 'member' },
                      {
                        onSuccess: () =>
                          toast.success(
                            `${m.displayName} is now ${e.target.value === 'admin' ? 'an Admin' : 'a Member'}`,
                          ),
                      },
                    )
                  }
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                </Select>
              ) : (
                <Badge tone={roleTone[m.role]}>{ORG_ROLE_LABEL[m.role]}</Badge>
              )}
            </div>
            <div className="min-w-[8rem] flex-1 text-xs text-muted" data-testid="member-projects">
              {m.allProjects
                ? 'All projects'
                : m.projects.length
                  ? m.projects.map((p) => p.key).join(', ')
                  : 'No projects yet'}
            </div>
            <div className="w-24 text-xs">
              {m.twoFactorEnabled ? (
                <span className="inline-flex items-center gap-1 text-success-soft-fg">
                  <ShieldCheck aria-hidden="true" className="size-3.5" />
                  2FA on
                </span>
              ) : (
                <span className="text-subtle">2FA off</span>
              )}
            </div>
            {manager && (
              <div className="w-9">
                {canTouch(m) || canResetPassword(m) ? (
                  <Menu label={`Actions for ${m.displayName}`}>
                    {m.role === 'member' && (
                      <MenuItem
                        onSelect={() => {
                          setAssigning(m);
                          setPicked(m.projects.map((p) => p.id));
                        }}
                      >
                        Change projects
                      </MenuItem>
                    )}
                    {me.role === 'owner' && m.twoFactorEnabled && (
                      <MenuItem
                        description="They set it up again at their next sign-in"
                        onSelect={() =>
                          reset.mutate(m.userId, {
                            onSuccess: () => toast.success(`Two-factor login of ${m.displayName} reset`),
                          })
                        }
                      >
                        Reset two-factor login
                      </MenuItem>
                    )}
                    {canResetPassword(m) && (
                      <MenuItem
                        description="Give them a temporary password to pass on"
                        onSelect={() => setResettingPassword(m)}
                      >
                        Reset password
                      </MenuItem>
                    )}
                    {canTouch(m) && <MenuSeparator />}
                    {canTouch(m) && (
                      <MenuItem danger onSelect={() => setRemoving(m)}>
                        Remove from organization
                      </MenuItem>
                    )}
                  </Menu>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="px-4 pb-3 empty:hidden">
        <ErrorBox error={role.error ?? reset.error ?? remove.error ?? resetPassword.error} />
      </div>
      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        canInviteAdmin={me.role === 'owner'}
        projects={orgProjects}
        used={used}
        max={max ?? null}
      />

      <ConfirmDialog
        open={!!resettingPassword}
        onOpenChange={(o) => !o && setResettingPassword(null)}
        title={`Reset the password of ${resettingPassword?.displayName ?? ''}?`}
        description="You get a temporary password to pass on yourself (no email is sent). They are signed out everywhere, and must choose their own password the next time they sign in."
        confirmLabel="Reset password"
        pending={resetPassword.isPending}
        onConfirm={() =>
          resettingPassword &&
          resetPassword.mutate(resettingPassword.userId, {
            onSuccess: (r) => {
              setTemporary({ name: resettingPassword.displayName, password: r.temporaryPassword });
              setResettingPassword(null);
            },
            onError: () => setResettingPassword(null),
          })
        }
      >
        <p className="text-sm text-muted" data-testid="reset-password-global-note">
          A Guildwise HQ account is one account for every organization. If {resettingPassword?.displayName}{' '}
          also belongs to other organizations, this new password applies there too.
        </p>
      </ConfirmDialog>

      <Dialog
        open={!!temporary}
        onOpenChange={(o) => !o && setTemporary(null)}
        title={`Temporary password for ${temporary?.name ?? ''}`}
        description="This is shown once. Copy it and send it to them yourself, in a message only they can read. We do not keep it."
        footer={
          <Button variant="primary" onClick={() => setTemporary(null)}>
            Done
          </Button>
        }
      >
        <div className="flex items-center gap-2">
          <code
            className="flex-1 rounded-[8px] bg-neutral-soft px-3 py-2 font-mono text-base break-all select-all"
            data-testid="temporary-password"
          >
            {temporary?.password}
          </code>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(temporary?.password ?? '');
              toast.success('Copied');
            }}
          >
            <Copy aria-hidden="true" className="size-4" />
            Copy
          </Button>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.displayName ?? ''} from the organization?`}
        description="They lose access to the organization and its projects. Their other organizations are not touched."
        confirmLabel="Remove from organization"
        pending={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.userId, {
            onSuccess: (r) => {
              toast.success(`${removing.displayName} was removed`);
              setRemoving(null);
              if (r?.offboarding) setReport(r.offboarding);
            },
            onError: () => setRemoving(null),
          })
        }
      >
        {preview.isPending && <p className="text-sm text-muted">Checking what moves...</p>}
        {preview.data && (
          <ul className="space-y-1.5 text-sm text-muted" data-testid="removal-preview">
            <li>
              Projects:{' '}
              <strong className="text-fg">
                {preview.data.projects.map((p) => p.key).join(', ') || 'none'}
              </strong>
            </li>
            <li>
              Their agents ({preview.data.agents.length}) move to the Owner and need a new home
              {preview.data.agents.length ? `: ${preview.data.agents.map((a) => a.name).join(', ')}` : ''}.
            </li>
            <li>
              {preview.data.releasedCards.length} card{preview.data.releasedCards.length === 1 ? '' : 's'} an
              agent of theirs is working on go back to the queue.
            </li>
            <li>
              {preview.data.transferredCards.length} card
              {preview.data.transferredCards.length === 1 ? '' : 's'} they own move to the Owner.
            </li>
          </ul>
        )}
        {preview.data?.offboarding && preview.data.offboarding.length > 0 && (
          <div className="mt-3 border-t border-line pt-3">
            <p className="mb-1.5 text-sm font-medium text-fg">Offboarding checklist</p>
            <OffboardingChecklist steps={preview.data.offboarding} testId="removal-offboarding" />
            <p className="mt-2 text-xs text-subtle">
              Private chats and packs are deleted after {preview.data.privatePurgeDays} days. Everything else
              is done now and reported here.
            </p>
          </div>
        )}
      </ConfirmDialog>
      <OffboardingReportDialog report={report} onClose={() => setReport(null)} />

      <Dialog
        open={!!assigning}
        onOpenChange={(o) => !o && setAssigning(null)}
        title={`Projects of ${assigning?.displayName ?? ''}`}
        description="Members work in the projects they are given. Taking one away hands their agents and cards there to the Owner."
        footer={
          <>
            <Button variant="ghost" onClick={() => setAssigning(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={setProjects.isPending}
              onClick={() =>
                assigning &&
                setProjects.mutate(
                  { userId: assigning.userId, projectIds: picked },
                  {
                    onSuccess: () => {
                      toast.success('Projects saved');
                      setAssigning(null);
                    },
                  },
                )
              }
            >
              Save projects
            </Button>
          </>
        }
      >
        {orgProjects.length === 0 ? (
          <p className="text-sm text-muted">The organization has no projects yet.</p>
        ) : (
          <ul className="space-y-1">
            {orgProjects.map((p) => (
              <li key={p.id}>
                <label className="flex min-h-9 items-center gap-2.5 text-sm text-fg">
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
        )}
        <ErrorBox error={setProjects.error} />
      </Dialog>
    </Panel>
  );
}
