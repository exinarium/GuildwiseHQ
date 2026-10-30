import {
  DIAGNOSTICS_CONSENT_TEXT,
  DIAGNOSTICS_CONSENT_TITLE,
  DIAGNOSTICS_CONSENT_VERSION,
  type OrgDetailResponse,
  type OrgMode,
} from '@aom/shared';
import { ArrowRightLeft, LogOut, Share2, ShieldCheck } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useLeaveOrg, useOrgMembers, usePatchOrg, useTransferOwnership } from '../../api/queries/orgs.ts';
import { PasswordInput } from '../auth/PasswordInput.tsx';
import { HelpHint } from '../help/HelpHint.tsx';
import {
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  ErrorBox,
  Panel,
  Select,
  TextInput,
  useToast,
} from '../ui.tsx';
import { FollowUpPanel } from './FollowUpPanel.tsx';
import { OrgModePicker } from './OrgModePicker.tsx';

/** Name, owner and the Owner's controls: ownership transfer and the organization-wide two-factor requirement. */
export function GeneralTab({ org, userId }: { org: OrgDetailResponse; userId: string }) {
  const patch = usePatchOrg();
  const members = useOrgMembers();
  const leave = useLeaveOrg();
  const transfer = useTransferOwnership();
  const toast = useToast();
  const [name, setName] = useState(org.name);
  const [transferring, setTransferring] = useState(false);
  const [target, setTarget] = useState('');
  const [password, setPassword] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [consenting, setConsenting] = useState(false);
  useEffect(() => setName(org.name), [org.name]);
  const manager = org.role === 'owner' || org.role === 'admin';
  const isOwner = org.role === 'owner';
  const candidates = (members.data ?? []).filter((m) => m.userId !== userId && m.role !== 'owner');

  const save = (e: FormEvent) => {
    e.preventDefault();
    patch.mutate({ name: name.trim() }, { onSuccess: () => toast.success('Organization renamed') });
  };

  return (
    <div className="flex flex-col gap-5">
      <Panel>
        <h2 className="text-lg font-semibold text-fg">Organization</h2>
        <form
          onSubmit={save}
          className="mt-3 flex flex-wrap items-end gap-3"
          aria-label="Rename organization"
        >
          <div className="min-w-[14rem] flex-1">
            <TextInput
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              readOnly={!manager}
              maxLength={120}
            />
          </div>
          {manager && (
            <Button
              type="submit"
              variant="primary"
              loading={patch.isPending}
              disabled={!name.trim() || name.trim() === org.name}
            >
              Save
            </Button>
          )}
        </form>
        <ErrorBox error={patch.error} />
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-subtle">Owner</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-3 text-fg">
              <span>
                <span className="font-medium">{org.owner.displayName}</span>
                <span className="block text-xs text-subtle">{org.owner.email}</span>
              </span>
              {isOwner && (
                <Button size="sm" onClick={() => setTransferring(true)} data-testid="transfer-ownership">
                  <ArrowRightLeft aria-hidden="true" className="size-4" />
                  Transfer ownership
                </Button>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Your role</dt>
            <dd className="mt-0.5 font-medium text-fg capitalize">{org.role}</dd>
          </div>
        </dl>
      </Panel>

      <ModePanel org={org} manager={manager} />

      <Panel data-testid="security-policy">
        <div className="flex flex-wrap items-start gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
            <ShieldCheck aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-1 text-lg font-semibold text-fg">
              Require two-factor login
              <HelpHint article="two-factor#enforcement" label="About requiring two-factor login">
                When this is on, every member must sign in with a code from an authenticator app. Anyone who
                has not set it up is asked to at their next visit.
              </HelpHint>
            </h2>
            <p className="mt-1 text-sm text-muted">
              Every member signs in with a code from an authenticator app. Members who have not set it up are
              asked to at their next visit.
            </p>
          </div>
          <label className="flex items-center gap-2.5 text-sm font-medium text-fg">
            <input
              type="checkbox"
              role="switch"
              aria-checked={org.requireTwoFactor}
              data-testid="require-2fa"
              className="size-5"
              checked={org.requireTwoFactor}
              disabled={!isOwner || patch.isPending}
              onChange={(e) =>
                patch.mutate(
                  { requireTwoFactor: e.target.checked },
                  {
                    onSuccess: () =>
                      toast.success(
                        e.target.checked
                          ? 'Two-factor login is now required'
                          : 'Two-factor login is optional again',
                      ),
                  },
                )
              }
            />
            {org.requireTwoFactor ? 'Required' : 'Optional'}
          </label>
        </div>
        {!isOwner && <p className="mt-2 text-xs text-subtle">Only the Owner changes this.</p>}
      </Panel>

      <FollowUpPanel canChange={manager} />

      {/*
        The diagnostic-data consent. Customer organizations only get this panel once the consent text has been reviewed
        under POPIA: the server answers `diagnosticsSharingAvailable: false` (flag AOM_DIAGNOSTICS_CONSENT_CUSTOMERS,
        off by default) and refuses the change. The platform organization always has it.
      */}
      {org.diagnosticsSharingAvailable && (
        <Panel data-testid="diagnostics-sharing">
          <div className="flex flex-wrap items-start gap-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
              <Share2 aria-hidden="true" className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold text-fg">{DIAGNOSTICS_CONSENT_TITLE}</h2>
              <p className="mt-1 text-sm text-muted">
                Your CEO may share generic, scrubbed records of the problems it notices, to improve Guildwise
                HQ and as topics for the blog. You are asked before anything is sent.
              </p>
            </div>
            <label className="flex items-center gap-2.5 text-sm font-medium text-fg">
              <input
                type="checkbox"
                role="switch"
                aria-checked={org.diagnosticsSharing}
                data-testid="diagnostics-sharing-toggle"
                className="size-5"
                checked={org.diagnosticsSharing}
                disabled={!isOwner || patch.isPending}
                onChange={(e) => {
                  if (e.target.checked) setConsenting(true);
                  else
                    patch.mutate(
                      { diagnosticsSharing: false },
                      { onSuccess: () => toast.success('Diagnostic data is no longer shared') },
                    );
                }}
              />
              {org.diagnosticsSharing ? 'On' : 'Off'}
            </label>
          </div>
          {!isOwner && <p className="mt-2 text-xs text-subtle">Only the Owner changes this.</p>}
          <ConfirmDialog
            open={consenting}
            onOpenChange={setConsenting}
            title={`${DIAGNOSTICS_CONSENT_TITLE}?`}
            confirmLabel="I agree, share"
            tone="primary"
            pending={patch.isPending}
            onConfirm={() =>
              patch.mutate(
                { diagnosticsSharing: true, consentVersion: DIAGNOSTICS_CONSENT_VERSION },
                {
                  onSuccess: () => {
                    setConsenting(false);
                    toast.success('Diagnostic data sharing is on');
                  },
                },
              )
            }
          >
            <div className="flex flex-col gap-2 text-sm text-muted" data-testid="diagnostics-consent-text">
              {DIAGNOSTICS_CONSENT_TEXT.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </ConfirmDialog>
        </Panel>
      )}

      {!isOwner && (
        <Panel>
          <h2 className="text-lg font-semibold text-fg">Leave this organization</h2>
          <p className="mt-1 text-sm text-muted">
            You lose access to its projects. Agents you hired go back to the Owner and need a new home.
          </p>
          <Button className="mt-3" variant="danger" onClick={() => setLeaving(true)} data-testid="leave-org">
            <LogOut aria-hidden="true" className="size-4" />
            Leave organization
          </Button>
        </Panel>
      )}

      <Dialog
        open={transferring}
        onOpenChange={setTransferring}
        title="Transfer ownership"
        description="The new Owner has full control and you become an Admin. Enter your password to confirm."
        footer={
          <>
            <Button variant="ghost" onClick={() => setTransferring(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={transfer.isPending}
              disabled={!target || !password}
              onClick={() =>
                transfer.mutate(
                  { userId: target, password },
                  {
                    onSuccess: () => {
                      toast.success('Ownership transferred');
                      setTransferring(false);
                      setPassword('');
                    },
                  },
                )
              }
            >
              Transfer ownership
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Select label="New Owner" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a member</option>
            {candidates.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName} ({m.role})
              </option>
            ))}
          </Select>
          <PasswordInput
            label="Your password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <ErrorBox error={transfer.error} />
        </div>
      </Dialog>

      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Leave ${org.name}?`}
        description="You will not be able to open its projects any more unless someone invites you again."
        confirmLabel="Leave organization"
        pending={leave.isPending}
        onConfirm={() =>
          leave.mutate(undefined, {
            onSuccess: () => {
              toast.success(`You left ${org.name}`);
              window.location.assign('/');
            },
            onError: () => setLeaving(false),
          })
        }
      />
    </div>
  );
}

interface ModeBlockers {
  repositories?: { project: string; name: string }[];
  agents?: { name: string; role: string }[];
}

/** Developer or Business mode. Owners and Admins change it; everyone else reads it. */
function ModePanel({ org, manager }: { org: OrgDetailResponse; manager: boolean }) {
  const patch = usePatchOrg();
  const toast = useToast();
  const [confirming, setConfirming] = useState<OrgMode | null>(null);
  const [blocked, setBlocked] = useState<{ message: string; blockers: ModeBlockers } | null>(null);
  const change = (mode: OrgMode) => {
    setBlocked(null);
    patch.mutate(
      { mode },
      {
        onSuccess: () => toast.success(mode === 'business' ? 'Business mode is on' : 'Developer mode is on'),
        onError: (e) => {
          if (e instanceof ApiError && e.code === 'business_mode_blocked')
            setBlocked({ message: e.message, blockers: (e.details ?? {}) as ModeBlockers });
        },
      },
    );
  };
  const pick = (mode: OrgMode) => {
    if (mode === org.mode) return;
    if (mode === 'business') setConfirming(mode);
    else change(mode);
  };
  return (
    <Panel data-testid="org-mode-panel">
      <OrgModePicker value={org.mode} onChange={pick} disabled={!manager || patch.isPending} />
      {!manager && <p className="mt-2 text-xs text-subtle">Only the Owner and Admins change this.</p>}
      {blocked && (
        <Callout tone="warning" title="Business mode is not possible yet" data-testid="org-mode-blocked">
          <p>{blocked.message}</p>
          <ul className="mt-1 list-disc pl-5">
            {(blocked.blockers.repositories ?? []).map((r) => (
              <li key={`${r.project}-${r.name}`}>
                Repository {r.name} (project {r.project})
              </li>
            ))}
            {(blocked.blockers.agents ?? []).map((a) => (
              <li key={a.name}>
                {a.name} ({a.role})
              </li>
            ))}
          </ul>
        </Callout>
      )}
      {!blocked &&
        patch.error &&
        !(patch.error instanceof ApiError && patch.error.code === 'business_mode_blocked') && (
          <ErrorBox error={patch.error} />
        )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(o) => !o && setConfirming(null)}
        title="Switch to Business mode?"
        description="Repository, branch, DevOps and code-role screens will be hidden. Nothing is deleted; switching back shows them again."
        confirmLabel="Switch to Business mode"
        tone="primary"
        onConfirm={() => {
          const m = confirming;
          setConfirming(null);
          if (m) change(m);
        }}
      />
    </Panel>
  );
}
