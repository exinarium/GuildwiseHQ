import { ORG_FEATURES, type OrgFeature } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  useOrgStatusAction,
  usePatchPlatformOrg,
  usePlatformOrg,
  usePlatformTransfer,
  useSetSimulation,
  useWipeSimulation,
} from '../../api/queries/platform.ts';
import { OrgBillingPanel } from '../../components/platform/OrgBillingPanel.tsx';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  Select,
  TextArea,
  TextInput,
  useToast,
} from '../../components/ui.tsx';
import { formatDateTime } from '../../lib/time.ts';
import { STATUS_TONE } from './PlatformOrgs.tsx';

const LIMITS = [
  ['maxMembers', 'Members'],
  ['maxWorkstations', 'Workstations'],
  ['maxProjects', 'Projects'],
] as const;
const FEATURE_LABEL: Record<OrgFeature, string> = {
  interests: 'Interests',
  integrations: 'Integrations and intake',
  outbound: 'Outbound updates',
  research: 'Research',
  phases: 'Phases',
  browserTools: 'Browser tools',
  customRoles: 'Custom roles and workflows',
};

type Pending = { kind: 'suspend' | 'reactivate' | 'cancel' } | { kind: 'transfer' } | null;

/** `/platform/orgs/:id`: one organization's metadata, licence editing, status actions, ownership transfer and audit. */
export function PlatformOrgDetail() {
  const { id = '' } = useParams();
  const org = usePlatformOrg(id);
  const patch = usePatchPlatformOrg(id);
  const status = useOrgStatusAction(id);
  const transfer = usePlatformTransfer(id);
  const simulate = useSetSimulation(id);
  const wipe = useWipeSimulation(id);
  const navigate = useNavigate();
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeName, setWipeName] = useState('');
  const toast = useToast();
  const [dialog, setDialog] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [toUserId, setToUserId] = useState('');
  const [note, setNote] = useState('');
  const [limits, setLimits] = useState<Record<string, string> | null>(null);
  const [features, setFeatures] = useState<Record<string, boolean | null> | null>(null);
  const [license, setLicense] = useState<string | null>(null);

  if (org.isPending) return <PageSkeleton label="Loading organization" />;
  if (!org.data) return <ErrorBox error={org.error} />;
  const o = org.data;
  const limitVal = (k: (typeof LIMITS)[number][0]) =>
    limits?.[k] ?? (o.limits[k] === null ? '' : String(o.limits[k]));
  const featureVal = (f: OrgFeature): boolean | null =>
    features && f in features ? (features[f] ?? null) : (o.featureOverrides[f] ?? null);
  const dirty = limits !== null || features !== null || license !== null;

  const close = () => {
    setDialog(null);
    setReason('');
    setToUserId('');
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body: Parameters<typeof patch.mutate>[0] = { note: note.trim() };
    if (limits)
      body.limits = {
        ...Object.fromEntries(
          LIMITS.map(([k]) => [k, limitVal(k).trim() === '' ? null : Number(limitVal(k))]),
        ),
        maxAgents: null, // plans never limit agents
      } as never;
    if (features) body.features = features as never;
    if (license !== null) body.licenseExpiresAt = license === '' ? null : new Date(license).toISOString();
    patch.mutate(body, {
      onSuccess: () => {
        toast.success('Organization updated');
        setLimits(null);
        setFeatures(null);
        setLicense(null);
        setNote('');
      },
    });
  };
  const confirm = () => {
    if (!dialog) return;
    if (dialog.kind === 'transfer')
      transfer.mutate(
        { toUserId, reason: reason.trim() },
        { onSuccess: () => (toast.success('Ownership transferred'), close()) },
      );
    else
      status.mutate(
        { action: dialog.kind, reason: reason.trim() },
        { onSuccess: () => (toast.success(`Organization ${dialog.kind}d`), close()) },
      );
  };
  const err = status.error ?? transfer.error;
  const dialogTitle =
    dialog?.kind === 'transfer'
      ? 'Transfer ownership'
      : dialog
        ? `${dialog.kind[0]?.toUpperCase()}${dialog.kind.slice(1)} ${o.name}`
        : '';

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={o.name}
        back={{ to: '/platform', label: 'Organizations' }}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[o.status] ?? 'neutral'}>{o.status}</Badge>
            {o.simulation && <Badge tone="amber">Simulation</Badge>}
            <span>{o.planName}</span>
            {o.statusReason && <span className="text-sm text-subtle">({o.statusReason})</span>}
          </span>
        }
        actions={
          <>
            {o.status === 'suspended' ? (
              <Button variant="secondary" onClick={() => setDialog({ kind: 'reactivate' })}>
                Reactivate
              </Button>
            ) : (
              o.status !== 'cancelled' && (
                <Button variant="secondary" onClick={() => setDialog({ kind: 'suspend' })}>
                  Suspend
                </Button>
              )
            )}
            {o.status !== 'cancelled' && (
              <Button variant="danger-ghost" onClick={() => setDialog({ kind: 'cancel' })}>
                Cancel
              </Button>
            )}
          </>
        }
      />

      <Panel title="Overview" data-testid="platform-org-overview">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-subtle">Owner</dt>
            <dd className="mt-0.5 font-medium text-fg">{o.owner.displayName}</dd>
            <dd className="text-xs break-all text-subtle">{o.owner.email}</dd>
          </div>
          <div>
            <dt className="text-subtle">Members</dt>
            <dd className="tnum mt-0.5 font-medium text-fg">{o.memberCount}</dd>
          </div>
          <div>
            <dt className="text-subtle">Shifts in 30 days</dt>
            <dd className="tnum mt-0.5 font-medium text-fg">{o.shifts30d}</dd>
          </div>
          <div>
            <dt className="text-subtle">Created</dt>
            <dd className="mt-0.5 text-fg">{formatDateTime(o.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-subtle">Last active</dt>
            <dd className="mt-0.5 text-fg">{o.lastActiveAt ? formatDateTime(o.lastActiveAt) : 'Never'}</dd>
          </div>
          <div>
            <dt className="text-subtle">Two-factor login</dt>
            <dd className="mt-0.5 text-fg">{o.requireTwoFactor ? 'Required by the Owner' : 'Optional'}</dd>
          </div>
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3 text-sm">
          <span className="text-muted">
            Admins: {o.admins.length === 0 ? 'none' : o.admins.map((a) => a.displayName).join(', ')}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={o.admins.length === 0}
            onClick={() => setDialog({ kind: 'transfer' })}
          >
            Transfer ownership
          </Button>
          {o.admins.length === 0 && (
            <span className="text-xs text-subtle">Ownership moves to an existing Admin only.</span>
          )}
        </div>
      </Panel>

      <Panel title="Simulation" data-testid="platform-org-simulation">
        <p className="mb-3 text-sm text-muted">
          A simulation organization is for testing and demos: its agents run on a simulated workstation hosted
          by this server (nothing real is built), it is never billed, and its emails are marked [Simulation].
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2.5 text-sm font-medium text-fg">
            <input
              type="checkbox"
              role="switch"
              aria-checked={o.simulation}
              data-testid="simulation-toggle"
              className="size-5"
              checked={o.simulation}
              disabled={simulate.isPending}
              onChange={(e) =>
                simulate.mutate(
                  { enabled: e.target.checked },
                  {
                    onSuccess: () =>
                      toast.success(e.target.checked ? 'Simulation is on' : 'Simulation is off'),
                  },
                )
              }
            />
            {o.simulation ? 'Simulation on' : 'Simulation off'}
          </label>
          {o.simulation && (
            <>
              <Select
                label="Pace of the simulated workstation"
                value={o.simulationPace}
                data-testid="simulation-pace"
                onChange={(e) =>
                  simulate.mutate(
                    { enabled: true, pace: e.target.value as 'fast' | 'normal' | 'slow' },
                    { onSuccess: () => toast.success('Pace updated') },
                  )
                }
              >
                <option value="fast">Fast (good for tests)</option>
                <option value="normal">Normal</option>
                <option value="slow">Slow (good for demos)</option>
              </Select>
              <Button
                variant="danger"
                data-testid="simulation-wipe"
                onClick={() => {
                  setWipeName('');
                  setWipeOpen(true);
                }}
              >
                Delete simulation organization
              </Button>
            </>
          )}
        </div>
        {simulate.isError && (
          <div className="mt-3">
            <ErrorBox error={simulate.error} />
          </div>
        )}
      </Panel>

      <Dialog
        open={wipeOpen}
        onOpenChange={(v) => !v && setWipeOpen(false)}
        title={`Delete ${o.name}`}
        description="This removes the organization and ALL its data for good: projects, cards, chats, events, and every account that belongs only to it (their email addresses become free again). It cannot be undone."
        footer={
          <>
            <Button variant="secondary" onClick={() => setWipeOpen(false)}>
              Back
            </Button>
            <Button
              variant="danger"
              data-testid="simulation-wipe-confirm"
              disabled={wipeName !== o.name || wipe.isPending}
              onClick={() =>
                wipe.mutate(
                  { confirmName: wipeName },
                  {
                    onSuccess: (r) => {
                      toast.success(
                        `${r.orgName} deleted (${r.deletedUsers.length} account${r.deletedUsers.length === 1 ? '' : 's'} removed)`,
                      );
                      setWipeOpen(false);
                      navigate('/platform');
                    },
                  },
                )
              }
            >
              Delete everything
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">
            The server does not back up the database for you. On a production database, take a backup first.
          </p>
          <TextInput
            label={`Type the organization name (${o.name}) to confirm`}
            value={wipeName}
            onChange={(e) => setWipeName(e.target.value)}
            data-testid="simulation-wipe-name"
          />
          {wipe.isError && <ErrorBox error={wipe.error} />}
        </div>
      </Dialog>

      <form onSubmit={save} data-testid="platform-org-licence">
        <Panel title="Plan, limits and features">
          <p className="mb-3 text-sm text-muted">
            The Founding plan has no limits. Leave a limit empty for unlimited. Every change is recorded in
            the audit log.
          </p>
          <div className="grid gap-3 sm:grid-cols-4">
            {LIMITS.map(([k, label]) => (
              <TextInput
                key={k}
                label={label}
                inputMode="numeric"
                placeholder="Unlimited"
                value={limitVal(k)}
                onChange={(e) => setLimits({ ...(limits ?? {}), [k]: e.target.value.replace(/\D/g, '') })}
              />
            ))}
          </div>
          <div className="mt-3 max-w-xs">
            <TextInput
              label="Licence expires"
              type="date"
              value={license ?? (o.licenseExpiresAt ? o.licenseExpiresAt.slice(0, 10) : '')}
              onChange={(e) => setLicense(e.target.value)}
            />
          </div>
          <fieldset className="mt-4 grid gap-3 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-medium text-fg">Features</legend>
            {ORG_FEATURES.map((f) => (
              <Select
                key={f}
                label={FEATURE_LABEL[f]}
                value={featureVal(f) === null ? 'plan' : featureVal(f) ? 'on' : 'off'}
                onChange={(e) =>
                  setFeatures({
                    ...(features ?? {}),
                    [f]: e.target.value === 'plan' ? null : e.target.value === 'on',
                  })
                }
              >
                <option value="plan">Plan default ({o.features[f] ? 'on' : 'off'})</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </Select>
            ))}
          </fieldset>
          {dirty && (
            <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
              <TextArea
                label="Reason for the change"
                required
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              {patch.isError && <ErrorBox error={patch.error} />}
              <div className="flex gap-2">
                <Button type="submit" disabled={patch.isPending || !note.trim()}>
                  Save changes
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setLimits(null);
                    setFeatures(null);
                    setLicense(null);
                  }}
                >
                  Discard
                </Button>
              </div>
            </div>
          )}
        </Panel>
      </form>

      <OrgBillingPanel orgId={id} />

      <Panel title="Recent activity" padding="none">
        {o.recentAudit.length === 0 ? (
          <p className="p-4 text-sm text-muted">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {o.recentAudit.map((r) => (
              <li key={r.seq} className="px-4 py-2.5">
                <span className="text-fg">{r.summary}</span>
                <span className="block text-xs text-subtle">
                  {formatDateTime(r.at)} · {r.actorName ?? r.actorKind}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Dialog
        open={!!dialog}
        onOpenChange={(v) => !v && close()}
        title={dialogTitle}
        description={
          dialog?.kind === 'suspend'
            ? 'Running shifts finish and nothing new starts. Only the Owner can sign in.'
            : dialog?.kind === 'cancel'
              ? 'The organization is closed. Its data is kept.'
              : dialog?.kind === 'transfer'
                ? 'Choose an existing Admin to become the Owner. The current Owner becomes an Admin.'
                : 'The organization runs again.'
        }
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Back
            </Button>
            <Button
              variant={dialog?.kind === 'cancel' ? 'danger' : 'primary'}
              disabled={
                !reason.trim() ||
                (dialog?.kind === 'transfer' && !toUserId) ||
                status.isPending ||
                transfer.isPending
              }
              onClick={confirm}
            >
              {dialogTitle.split(' ')[0]}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {dialog?.kind === 'transfer' && (
            <Select label="New Owner" value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
              <option value="">Choose an Admin</option>
              {o.admins.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName} ({a.email})
                </option>
              ))}
            </Select>
          )}
          <TextArea
            label="Reason (mandatory, audited)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {err && dialog && (
            <Callout tone="danger">{err instanceof Error ? err.message : 'Something went wrong'}</Callout>
          )}
        </div>
      </Dialog>
    </div>
  );
}
