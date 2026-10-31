import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import {
  useRelayIntegrations,
  useRevokeRelayIntegration,
  useRotateRelayIntegration,
} from '../../api/queries/relay.ts';
import { agoText } from '../../lib/ago.ts';
import {
  formatBytes,
  RELAY_KIND_LABEL,
  RELAY_OUTCOME_LABEL,
  type RelayRow,
  relayRowState,
} from '../../lib/relay.ts';
import { formatDate } from '../../lib/time.ts';
import {
  Badge,
  Button,
  ConfirmDialog,
  Disclosure,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  Panel,
  useToast,
} from '../ui.tsx';
import { RelayCreateDialog, type RelayReveal, RelayUrlDialog } from './RelayDialogs.tsx';
import { RelaySetupSteps } from './RelaySetupSteps.tsx';

function lastEventText(r: RelayRow): string {
  if (r.status === 'revoked') return '–';
  const e = r.live?.lastEvent;
  if (!e) return 'No requests yet';
  return [
    agoText(e.at),
    RELAY_OUTCOME_LABEL[e.outcome] ?? e.outcome,
    String(e.status),
    formatBytes(e.sizeBytes),
  ].join(' · ');
}

function StateBadge({ row }: { row: RelayRow }) {
  const state = relayRowState(row);
  if (state === 'revoked')
    return <Badge>Revoked{row.revokedAt ? ` ${formatDate(row.revokedAt)}` : ''}</Badge>;
  if (state === 'connected') {
    const n = row.live?.servingWorkstations ?? 0;
    return <Badge tone="success">Active · runner connected{n > 1 ? ` on ${n} workstations` : ''}</Badge>;
  }
  return <Badge tone="warning">Active · runner offline</Badge>;
}

/** Inbound webhooks of a Business organization: list, create, rotate, revoke. Members read; managers change. */
export function RelayTab({ canManage }: { canManage: boolean }) {
  const list = useRelayIntegrations();
  const rotate = useRotateRelayIntegration();
  const revoke = useRevokeRelayIntegration();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  // The one-time address lives in this state only while its dialog is open.
  const [reveal, setReveal] = useState<RelayReveal | null>(null);
  const [rotating, setRotating] = useState<RelayRow | null>(null);
  const [revoking, setRevoking] = useState<RelayRow | null>(null);

  const rows = [...(list.data ?? [])].sort(
    (a, b) => Number(a.status === 'revoked') - Number(b.status === 'revoked'),
  );

  const doRotate = async () => {
    if (!rotating) return;
    const row = rotating;
    try {
      const res = await rotate.mutateAsync(row.id);
      rotate.reset();
      setRotating(null);
      setReveal({ integration: res.integration, url: res.url });
    } catch (e) {
      setRotating(null);
      toast.error(errorMessage(e));
    }
  };
  const doRevoke = async () => {
    if (!revoking) return;
    try {
      await revoke.mutateAsync(revoking.id);
      toast.success(`Revoked ${revoking.label}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setRevoking(null);
  };

  return (
    <div className="space-y-4" data-testid="relay-tab">
      <Panel
        title="Inbound webhooks"
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)} data-testid="relay-new">
              New inbound webhook
            </Button>
          ) : undefined
        }
      >
        <p className="mb-4 text-sm text-muted">
          A private web address per provider. Guildwise HQ passes each request straight to the runner on your
          workstation and keeps only the time, size and result. Secrets stay on your workstation.
        </p>
        {list.isPending ? (
          <ListSkeleton />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No inbound webhooks yet"
            description={
              canManage ? 'Create one to receive messages from a provider.' : 'An Owner or Admin can add one.'
            }
          />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.id} className="space-y-2 py-3" data-testid={`relay-row-${r.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-fg">{r.label}</span>
                  <Badge>{RELAY_KIND_LABEL[r.kind]}</Badge>
                  <StateBadge row={r} />
                </div>
                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="inline text-muted">Created </dt>
                    <dd className="inline">
                      {formatDate(r.createdAt)}
                      {r.rotatedAt && ` · address rotated ${formatDate(r.rotatedAt)}`}
                    </dd>
                  </div>
                  <div>
                    <dt className="inline text-muted">Serving runner connected </dt>
                    <dd className="inline" data-testid={`relay-runner-${r.id}`}>
                      {r.status === 'revoked' ? '–' : r.live?.connected ? 'yes' : 'no'}
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="inline text-muted">Last event </dt>
                    <dd className="inline" data-testid={`relay-last-${r.id}`}>
                      {lastEventText(r)}
                    </dd>
                  </div>
                  {r.status === 'active' && r.live && !r.live.everServed && (
                    <div className="sm:col-span-2 text-muted">No runner has served it yet.</div>
                  )}
                </dl>
                {r.status === 'active' && (
                  <Disclosure summary="Setup steps" data-testid={`relay-setup-${r.id}`}>
                    <RelaySetupSteps integration={r} addressKnown={false} />
                  </Disclosure>
                )}
                {canManage && r.status === 'active' && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setRotating(r)} data-testid={`relay-rotate-${r.id}`}>
                      Rotate address
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setRevoking(r)}
                      data-testid={`relay-revoke-${r.id}`}
                    >
                      Revoke
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {canManage && <RelayCreateDialog open={creating} onOpenChange={setCreating} onCreated={setReveal} />}
      <RelayUrlDialog reveal={reveal} onClose={() => setReveal(null)} />
      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(o) => !o && setRotating(null)}
        title={`Rotate the address of ${rotating?.label ?? ''}?`}
        description="The old address stops working at once. Update it at the provider."
        confirmLabel="Rotate address"
        tone="primary"
        pending={rotate.isPending}
        onConfirm={() => void doRotate()}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.label ?? ''}?`}
        description="Requests to this address get 'not found'. This cannot be undone."
        confirmLabel="Revoke"
        pending={revoke.isPending}
        onConfirm={() => void doRevoke()}
      />
    </div>
  );
}
