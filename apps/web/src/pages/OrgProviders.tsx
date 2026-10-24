import { formatMoney, type OrgProvider, type OrgProviderWorkstation, type ProviderKeyId } from '@aom/shared';
import { useState } from 'react';
import { useMe } from '../api/queries/auth.ts';
import {
  type SealTarget,
  useOrgProviders,
  useOverrideOrgProviderCap,
  useReshareOrgProviderKey,
  useRevokeOrgProviderKey,
  useSetOrgProviderCap,
  useSetOrgProviderKey,
  useShareOrgProviderKey,
} from '../api/queries/org-providers.ts';
import {
  type CredentialDraft,
  CredentialFields,
  detailOf,
  draftProblem,
  emptyDraft,
  parseModelIds,
  secretOf,
} from '../components/providers/CredentialFields.tsx';
import { ModelPrices } from '../components/providers/ModelPrices.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  TextInput,
  useToast,
} from '../components/ui.tsx';

const SHARE_TEXT: Record<
  OrgProviderWorkstation['status'],
  { label: string; tone: 'green' | 'neutral' | 'amber' | 'red' }
> = {
  stored: { label: 'Has the key', tone: 'green' },
  queued: { label: 'Sending', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'red' },
  not_shared: { label: 'Not shared', tone: 'amber' },
  too_old: { label: 'Update the runner', tone: 'amber' },
};

const usd = (micros: number): string => formatMoney(micros, 'USD');

/**
 * Settings > Model providers (Owner and Admins; docs/ARCHITECTURE.md section 38.5): the organization-wide provider keys with a
 * monthly spend cap per provider. A key is encrypted in this browser for each workstation's runner; Guildwise's servers keep
 * only those ciphertexts and the runners decrypt. A workstation's own key overrides the organization's and is not capped.
 */
export function OrgProviders() {
  const me = useMe();
  const role = me.data?.activeOrg?.role;
  const manager = role === 'owner' || role === 'admin';
  if (me.isPending) return <PageSkeleton label="Loading" />;
  if (!manager)
    return (
      <EmptyState
        title="Owners and Admins only"
        description="Ask an Owner or Admin to manage the organization's model provider keys."
      />
    );
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4" data-testid="org-providers">
      <PageHeader
        title="Model providers"
        sub="Keys your whole organization can use, with a monthly spend cap per provider. A workstation's own key overrides them and is not capped."
      />
      <OrgProvidersBody />
    </div>
  );
}

/** The keys and caps themselves (also the "Model providers" tab of the organization settings). Managers only: the caller checks. */
export function OrgProvidersBody() {
  const list = useOrgProviders();
  return (
    <div className="flex flex-col gap-4">
      <Callout tone="info">
        A key is encrypted in your browser for each workstation's runner and kept only there. Guildwise's
        servers store the encrypted copies and pass them on; they never see the key or your model traffic.
        Revoking a key removes it from every workstation.
      </Callout>
      <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      {list.isPending ? (
        <PageSkeleton label="Loading providers" />
      ) : (
        <ul className="flex flex-col gap-3">
          {(list.data?.providers ?? []).map((p) => (
            <ProviderCard key={p.provider} p={p} />
          ))}
        </ul>
      )}
      <ModelPrices />
    </div>
  );
}

function ProviderCard({ p }: { p: OrgProvider }) {
  const [open, setOpen] = useState(false);
  const [revoke, setRevoke] = useState(false);
  const revokeKey = useRevokeOrgProviderKey(p.provider);
  const toast = useToast();
  const sealable = p.workstations.filter((w) => w.supported && w.keyId && w.publicKey);
  return (
    <li data-testid={`org-provider-${p.provider}`}>
      <Panel
        title={p.label}
        actions={
          <>
            <Badge
              tone={p.configured ? 'green' : 'neutral'}
              data-testid={`org-provider-status-${p.provider}`}
            >
              {p.configured ? 'Key set' : 'No key'}
            </Badge>
            <Button size="sm" onClick={() => setOpen(true)} data-testid={`org-provider-set-${p.provider}`}>
              {p.configured ? 'Replace key' : 'Set key'}
            </Button>
            {p.configured && (
              <Button
                size="sm"
                variant="danger-ghost"
                onClick={() => setRevoke(true)}
                data-testid={`org-provider-revoke-${p.provider}`}
              >
                Revoke
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          {p.configured && (
            <p className="text-muted">
              {p.detail ? `${p.detail}. ` : ''}
              {p.setByName
                ? `Set by ${p.setByName}${p.setAt ? ` on ${new Date(p.setAt).toLocaleDateString()}` : ''}.`
                : ''}
            </p>
          )}
          <CapRow p={p} />
          {p.configured && <WorkstationList p={p} />}
          {!p.configured && (
            <p className="text-muted" data-testid={`org-provider-empty-${p.provider}`}>
              No organization key. Agents use a workstation's own key where it has one.
            </p>
          )}
        </div>
      </Panel>
      {open && (
        <SetKeyDialog
          p={p}
          targets={sealable}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            toast.success(`${p.label} key sent`);
          }}
        />
      )}
      <ConfirmDialog
        open={revoke}
        onOpenChange={setRevoke}
        title={`Revoke the ${p.label} key?`}
        description="Every workstation forgets the organization's key now. Agents that used it stop working until another key is set; a workstation's own key is not affected."
        confirmLabel="Revoke key"
        pending={revokeKey.isPending}
        onConfirm={() =>
          revokeKey.mutate(undefined, {
            onSuccess: () => {
              setRevoke(false);
              toast.success(`${p.label} key revoked`);
            },
          })
        }
      />
    </li>
  );
}

function CapRow({ p }: { p: OrgProvider }) {
  const set = useSetOrgProviderCap(p.provider);
  const override = useOverrideOrgProviderCap(p.provider);
  const toast = useToast();
  const cap = p.cap;
  const [text, setText] = useState(cap.monthlyMicros ? String(cap.monthlyMicros / 1_000_000) : '');
  const parsed = text.trim() === '' ? null : Number(text);
  const bad = parsed !== null && !(Number.isFinite(parsed) && parsed >= 0.01);
  const pct = cap.percent === null ? 0 : Math.min(100, Math.round(cap.percent));
  const tone =
    cap.state === 'paused'
      ? 'red'
      : cap.state === 'warning'
        ? 'amber'
        : cap.state === 'overridden'
          ? 'neutral'
          : 'green';
  return (
    <div className="flex flex-col gap-2" data-testid={`org-provider-cap-${p.provider}`}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-44">
          <TextInput
            label="Monthly cap (USD)"
            type="number"
            min={0.01}
            step={1}
            inputMode="decimal"
            value={text}
            placeholder="No cap"
            data-testid={`org-provider-cap-input-${p.provider}`}
            onChange={(e) => setText(e.target.value)}
            error={bad ? 'At least 0.01' : undefined}
          />
        </div>
        <Button
          size="sm"
          disabled={bad || set.isPending || (parsed === null && cap.monthlyMicros === null)}
          loading={set.isPending}
          data-testid={`org-provider-cap-save-${p.provider}`}
          onClick={() =>
            set.mutate(parsed, {
              onSuccess: () => toast.success(parsed === null ? 'Cap removed' : 'Cap saved'),
            })
          }
        >
          {parsed === null ? 'Remove cap' : 'Save cap'}
        </Button>
        {cap.state === 'paused' && (
          <Button
            size="sm"
            variant="secondary"
            loading={override.isPending}
            data-testid={`org-provider-cap-override-${p.provider}`}
            onClick={() =>
              override.mutate(undefined, { onSuccess: () => toast.success('Overridden for this month') })
            }
          >
            Override for this month
          </Button>
        )}
      </div>
      <p className="text-muted" data-testid={`org-provider-spend-${p.provider}`}>
        This month ({cap.month}): {usd(cap.spendMicros)} spent on the organization's key
        {cap.monthlyMicros ? ` of ${usd(cap.monthlyMicros)}` : ''}. Resets{' '}
        {new Date(cap.resetsAt).toLocaleDateString()}.
      </p>
      {cap.monthlyMicros ? (
        <div className="flex items-center gap-2">
          <div
            className="h-2 w-48 overflow-hidden rounded-full bg-sunken"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${p.label} cap used`}
          >
            <div
              className={
                tone === 'red'
                  ? 'h-full bg-danger-fill'
                  : tone === 'amber'
                    ? 'h-full bg-warning-fill'
                    : 'h-full bg-brand'
              }
              style={{ width: `${pct}%` }}
            />
          </div>
          <Badge tone={tone} data-testid={`org-provider-cap-state-${p.provider}`}>
            {cap.state === 'paused'
              ? 'Cap reached: new runs are refused'
              : cap.state === 'warning'
                ? `${pct}% used`
                : cap.state === 'overridden'
                  ? 'Cap overridden this month'
                  : `${pct}% used`}
          </Badge>
        </div>
      ) : null}
      {cap.unknownCostTurns > 0 && (
        <Callout tone="warning" data-testid={`org-provider-unknown-${p.provider}`}>
          {cap.unknownCostTurns} run{cap.unknownCostTurns === 1 ? '' : 's'} this month used a model with no
          known price. They are not in the spend above, so the cap cannot count them and the real spend may be
          higher.
        </Callout>
      )}
      <ErrorBox error={set.error ?? override.error} />
    </div>
  );
}

function WorkstationList({ p }: { p: OrgProvider }) {
  const me = useMe();
  const share = useReshareOrgProviderKey(p.provider);
  const [again, setAgain] = useState<OrgProviderWorkstation | null>(null);
  // The admin sees the target runner's key fingerprint and approves it: the approval is sealed to the source runner.
  const [approving, setApproving] = useState<{
    source: OrgProviderWorkstation;
    target: OrgProviderWorkstation;
  } | null>(null);
  const toast = useToast();
  const holders = p.workstations.filter((w) => w.canShare);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-subtle">Workstations</p>
      {p.workstations.length === 0 && (
        <p className="text-muted">No workstations of the organization's members yet.</p>
      )}
      <ul className="flex flex-col gap-1.5">
        {p.workstations.map((w) => (
          <li
            key={w.workstationId}
            className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-canvas px-3 py-2"
            data-testid={`org-provider-ws-${p.provider}-${w.workstationId}`}
          >
            <span className="flex flex-col">
              <span className="font-medium text-fg">{w.name}</span>
              <span className="text-xs text-subtle">
                {w.ownerName}
                {w.online ? '' : ' · offline'}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              {w.overriddenByOwn && (
                <Badge
                  tone="neutral"
                  title="The owner of this workstation has a key of their own: it is used instead, and is not capped."
                >
                  Own key in use
                </Badge>
              )}
              <Badge tone={SHARE_TEXT[w.status].tone} title={w.error}>
                {SHARE_TEXT[w.status].label}
              </Badge>
              {(w.status === 'not_shared' || w.status === 'failed') && w.supported && (
                <>
                  {holders.length > 0 && w.online && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={share.isPending}
                      data-testid={`org-provider-reshare-${p.provider}-${w.workstationId}`}
                      title={`${holders[0]?.name} re-seals the key for ${w.name}. You do not have to type it again.`}
                      onClick={() =>
                        setApproving({ source: holders[0] as OrgProviderWorkstation, target: w })
                      }
                    >
                      Share from {holders[0]?.name}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid={`org-provider-enter-${p.provider}-${w.workstationId}`}
                    onClick={() => setAgain(w)}
                  >
                    Enter the key again
                  </Button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      <ErrorBox error={share.error} />
      {again && <ShareAgainDialog p={p} w={again} onClose={() => setAgain(null)} />}
      {approving && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setApproving(null)}
          title={`Share the ${p.label} key with ${approving.target.name}?`}
          description={`${approving.source.name} will encrypt the key for ${approving.target.name}'s runner, identified by the key id ${approving.target.keyId ?? '?'}. Only share it if that is the workstation you mean.`}
          confirmLabel="Approve and share"
          tone="primary"
          onConfirm={() => {
            const from = toTarget(approving.source);
            const to = toTarget(approving.target);
            const orgId = me.data?.activeOrg?.id;
            const userId = me.data?.user.id;
            if (!from || !to || !orgId || !userId) return setApproving(null);
            share.mutate(
              { orgId, approvedBy: userId, generation: p.generation, source: from, target: to },
              {
                onSuccess: () =>
                  toast.success(`${approving.source.name} is sending the key to ${approving.target.name}`),
              },
            );
            setApproving(null);
          }}
        />
      )}
    </div>
  );
}

const toTarget = (w: OrgProviderWorkstation): SealTarget | null =>
  w.keyId && w.publicKey ? { workstationId: w.workstationId, keyId: w.keyId, publicKey: w.publicKey } : null;

function ShareAgainDialog({
  p,
  w,
  onClose,
}: {
  p: OrgProvider;
  w: OrgProviderWorkstation;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<CredentialDraft>(emptyDraft());
  const me = useMe();
  const share = useShareOrgProviderKey(p.provider);
  const toast = useToast();
  const target = toTarget(w);
  const problem = draftProblem(p.provider, draft);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Share the ${p.label} key with ${w.name}`}
      description="Enter the key again. It is encrypted in your browser for this workstation's runner."
    >
      <div className="flex flex-col gap-3">
        <CredentialFields id={p.provider} draft={draft} onChange={setDraft} testPrefix="org-share" />
        <ErrorBox error={share.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!!problem || !target || !me.data?.activeOrg}
            loading={share.isPending}
            data-testid="org-share-send"
            onClick={() =>
              target &&
              share.mutate(
                {
                  secret: secretOf(p.provider, draft),
                  target,
                  orgId: me.data?.activeOrg?.id ?? '',
                  generation: p.generation,
                  baseUrl: p.baseUrl,
                },
                {
                  onSuccess: () => {
                    toast.success(`Key sent to ${w.name}`);
                    onClose();
                  },
                },
              )
            }
          >
            Send
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function SetKeyDialog({
  p,
  targets,
  onClose,
  onDone,
}: {
  p: OrgProvider;
  targets: OrgProviderWorkstation[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState<CredentialDraft>(emptyDraft());
  // Everything that can take it is ticked (a runner that is offline gets the key when it connects).
  const [picked, setPicked] = useState<Set<string>>(() => new Set(targets.map((t) => t.workstationId)));
  const me = useMe();
  const set = useSetOrgProviderKey(p.provider);
  const problem = draftProblem(p.provider, draft);
  const chosen = targets
    .filter((t) => picked.has(t.workstationId))
    .map(toTarget)
    .filter((t): t is SealTarget => !!t);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`${p.configured ? 'Replace' : 'Set'} the organization's ${p.label} key`}
      description="The key is encrypted here, once for each workstation you pick. Workstations you leave out forget the old key."
      size="lg"
    >
      <div className="flex flex-col gap-3">
        <CredentialFields id={p.provider} draft={draft} onChange={setDraft} testPrefix="org-set" />
        <fieldset className="flex flex-col gap-1.5" data-testid="org-set-targets">
          <legend className="text-sm font-medium text-fg">Workstations that get the key</legend>
          {targets.length === 0 && (
            <p className="text-sm text-muted">
              No workstation of the organization's members can take an organization key yet (the runner needs
              to be updated and connected once).
            </p>
          )}
          {targets.map((t) => (
            <label key={t.workstationId} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.has(t.workstationId)}
                onChange={() => toggle(t.workstationId)}
                data-testid={`org-set-target-${t.workstationId}`}
              />
              <span>
                {t.name}{' '}
                <span className="text-subtle">
                  · {t.ownerName}
                  {t.online ? '' : ' · offline: it gets the key when it connects'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <ErrorBox error={set.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!!problem || chosen.length === 0 || !me.data?.activeOrg}
            loading={set.isPending}
            data-testid="org-set-send"
            title={problem ?? (chosen.length === 0 ? 'Pick at least one workstation' : undefined)}
            onClick={() =>
              set.mutate(
                {
                  secret: secretOf(p.provider, draft),
                  targets: chosen,
                  orgId: me.data?.activeOrg?.id ?? '',
                  currentGeneration: p.generation,
                  models: parseModelIds(draft.models),
                  ...(detailOf(p.provider, draft) ? { detail: detailOf(p.provider, draft) } : {}),
                  ...(draft.baseUrl.trim()
                    ? { baseUrl: draft.baseUrl.trim() }
                    : draft.fields.baseUrl?.trim()
                      ? { baseUrl: draft.fields.baseUrl.trim() }
                      : {}),
                },
                { onSuccess: onDone },
              )
            }
          >
            Send to {chosen.length} workstation{chosen.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export type { ProviderKeyId };
