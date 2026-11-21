import type { AddPasskeyRequest, ApprovalItemDto, PasskeyRelayDto, WorkstationPasskeyDto } from '@aom/shared';
import {
  type PublicKeyCredentialCreationOptionsJSON,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useParams } from 'react-router';
import { errorMessage } from '../api/client.ts';
import {
  passkeyRegistrationOptions,
  useAddPasskey,
  useRelayPasskeyApproval,
  useRemovePasskey,
  useWorkstationApprovals,
  useWorkstationPasskeys,
} from '../api/queries/passkeys.ts';
import { useWorkstations } from '../api/queries/workstations.ts';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  TextInput,
} from '../components/ui.tsx';

/*
 * Workstation page > Approvals (R22, DESIGN R18-S2). What the runner holds for a local yes, and the passkeys it may trust.
 * A passkey approves only a redeploy at a new commit and a recipe write, and only once the workstation trusts it
 * (`guildwise-runner passkey trust` on the machine). This page comes from the server, so it can never be the authority:
 * the runner checks every assertion itself, and everything else needs `guildwise-runner approve` on the machine.
 */

const KIND_LABELS: Record<string, string> = {
  'deploy.commit_redeploy': 'Redeploy at a new commit',
  'recipe.write': 'Recipe change',
  'deploy.exec': 'Deploy',
  'vault.configure': 'Vault set-up',
  'env.secret': 'Secret reseal',
  'provider.reseal': 'Provider key reseal',
  'devops.task': 'DevOps task',
  'devops.request': 'DevOps request',
  sudo: 'Sudo',
  'release.sign': 'Release signature',
};
const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;
const shortId = (id: string) => id.slice(0, 12);
const when = (iso: string) => new Date(iso).toLocaleString();

/** WebAuthn in this browser, on the one origin passkeys are made for. */
function passkeySupport(origin: string | undefined): string | null {
  if (typeof window === 'undefined' || typeof window.PublicKeyCredential === 'undefined')
    return 'This browser cannot use passkeys.';
  if (origin && window.location.origin !== origin) return `Passkeys work only on ${origin}.`;
  return null;
}

/** A cancelled or timed-out passkey prompt reads as such, not as a failure. */
function webauthnMessage(e: unknown): string {
  if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError'))
    return 'The passkey prompt was cancelled or timed out.';
  return errorMessage(e);
}

export function WorkstationApprovals() {
  const { id = '' } = useParams();
  const list = useWorkstations();
  const passkeys = useWorkstationPasskeys(id);
  const approvals = useWorkstationApprovals(id);
  const ws = list.data?.find((w) => w.id === id);
  const support = passkeySupport(passkeys.data?.origin);

  return (
    <>
      <PageHeader
        title="Approvals"
        documentTitle={ws ? `Approvals · ${ws.name}` : 'Approvals'}
        sub={ws?.name}
        back={{ to: '/workstations', label: 'Workstations' }}
      />
      <Callout className="mb-5" data-testid="approvals-rule">
        The workstation decides what runs on it. A passkey can approve only two routine things: a redeploy at
        a new commit and a recipe change, and only after you trust it on the workstation with{' '}
        <code>guildwise-runner passkey trust</code>. Everything else needs{' '}
        <code>guildwise-runner approve</code> on the workstation itself.
      </Callout>
      <div className="flex flex-col gap-5">
        <HeldPanel id={id} approvals={approvals} rpId={passkeys.data?.rpId} support={support} />
        <PasskeysPanel id={id} passkeys={passkeys} support={support} />
      </div>
    </>
  );
}

function HeldPanel({
  id,
  approvals,
  rpId,
  support,
}: {
  id: string;
  approvals: ReturnType<typeof useWorkstationApprovals>;
  rpId: string | undefined;
  support: string | null;
}) {
  const relay = useRelayPasskeyApproval(id);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ itemId: string; message: string } | null>(null);

  async function approve(item: ApprovalItemDto) {
    if (!item.passkey || !rpId) return;
    setError(null);
    setBusy(item.id);
    try {
      const a = await startAuthentication({
        optionsJSON: {
          challenge: item.passkey.challenge,
          rpId,
          allowCredentials: item.passkey.credentialIds.map((c) => ({ id: c, type: 'public-key' as const })),
          userVerification: 'required',
          timeout: 120_000,
        },
      });
      await relay.mutateAsync({
        itemId: item.id,
        body: {
          credentialId: a.rawId,
          authenticatorData: a.response.authenticatorData,
          clientDataJSON: a.response.clientDataJSON,
          signature: a.response.signature,
          ...(a.response.userHandle ? { userHandle: a.response.userHandle } : {}),
        },
      });
    } catch (e) {
      setError({ itemId: item.id, message: webauthnMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  const data = approvals.data;
  return (
    <Panel title="Waiting for your yes" data-testid="held-items">
      {approvals.isPending ? (
        <ListSkeleton rows={2} />
      ) : approvals.error ? (
        <ErrorBox error={approvals.error} onRetry={() => void approvals.refetch()} />
      ) : !data?.online ? (
        <Callout tone="warning" role="status">
          This workstation is offline. What it holds shows here when its runner is connected.
        </Callout>
      ) : data.items.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description={
            data.reportedAt
              ? 'The workstation holds nothing for an approval right now.'
              : 'The workstation has not reported anything held since it connected.'
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {data.items.map((item) => (
            <HeldRow
              key={item.id}
              item={item}
              relay={latestRelay(data.relays, item.id)}
              busy={busy === item.id}
              error={error?.itemId === item.id ? error.message : null}
              support={support}
              onApprove={() => void approve(item)}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

const latestRelay = (relays: PasskeyRelayDto[], itemId: string) => relays.find((r) => r.itemId === itemId);

function HeldRow({
  item,
  relay,
  busy,
  error,
  support,
  onApprove,
}: {
  item: ApprovalItemDto;
  relay: PasskeyRelayDto | undefined;
  busy: boolean;
  error: string | null;
  support: string | null;
  onApprove: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" data-testid={`held-${item.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={item.passkeyApprovable ? 'info' : 'neutral'}>{kindLabel(item.kind)}</Badge>
        <span className="text-xs text-subtle">held since {when(item.createdAt)}</span>
      </div>
      {/* the runner's own words, shown as text */}
      <p className="text-sm break-words text-fg">{item.summary}</p>
      {item.passkeyApprovable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={onApprove}
            disabled={busy || !!support}
            data-testid={`approve-${item.id}`}
          >
            <KeyRound aria-hidden="true" className="size-4" />
            {busy ? 'Waiting for the passkey…' : 'Approve with passkey'}
          </Button>
          {support && <span className="text-xs text-subtle">{support}</span>}
        </div>
      ) : (
        <p className="text-sm text-muted" data-testid={`local-only-${item.id}`}>
          Confirm on the workstation: <code>guildwise-runner approve {item.id}</code>
        </p>
      )}
      {relay && <RelayStatus relay={relay} />}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

function RelayStatus({ relay }: { relay: PasskeyRelayDto }) {
  const text = {
    sent: 'Sent to the workstation; it checks the passkey itself.',
    accepted: 'The workstation accepted the passkey.',
    refused: `The workstation refused the passkey: ${relay.error ?? 'refused'}`,
    expired: 'The approval request expired before the workstation answered.',
  }[relay.status];
  return (
    <p
      role="status"
      data-testid={`relay-${relay.itemId}`}
      className={relay.status === 'refused' ? 'text-sm text-danger' : 'text-sm text-muted'}
    >
      {text}
    </p>
  );
}

function PasskeysPanel({
  id,
  passkeys,
  support,
}: {
  id: string;
  passkeys: ReturnType<typeof useWorkstationPasskeys>;
  support: string | null;
}) {
  const add = useAddPasskey(id);
  const remove = useRemovePasskey(id);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<WorkstationPasskeyDto | null>(null);
  const [removing, setRemoving] = useState<WorkstationPasskeyDto | null>(null);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Give the passkey a name.');
    setError(null);
    setAdded(null);
    setBusy(true);
    try {
      // "Confirm it's you" comes first when needed (the API client shows the dialog and retries).
      const o = await passkeyRegistrationOptions(id);
      const response = await startRegistration({
        optionsJSON: o.options as unknown as PublicKeyCredentialCreationOptionsJSON,
      });
      const dto = await add.mutateAsync({
        name: name.trim(),
        registrationToken: o.registrationToken,
        response: response as unknown as AddPasskeyRequest['response'],
      });
      setAdded(dto);
      setName('');
    } catch (err) {
      setError(webauthnMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const list = passkeys.data?.passkeys ?? [];
  return (
    <Panel title="Passkeys" data-testid="passkeys">
      {passkeys.isPending ? (
        <ListSkeleton rows={1} />
      ) : passkeys.error ? (
        <ErrorBox error={passkeys.error} onRetry={() => void passkeys.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          {list.length === 0 ? (
            <p className="text-sm text-muted">
              No passkey yet. Without one, approve everything on the workstation.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {list.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="block font-medium text-fg">{p.name}</span>
                    <span className="block text-xs text-subtle">
                      id {shortId(p.credentialId)}… · added {when(p.createdAt)}
                    </span>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setRemoving(p)}
                    aria-label={`Remove passkey ${p.name}`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {added && (
            <Callout tone="success" role="status" data-testid="passkey-added">
              Added. The workstation does not trust it yet: run <code>guildwise-runner passkey trust</code> on
              the workstation and trust the passkey whose id starts with{' '}
              <code>{shortId(added.credentialId)}</code>.
            </Callout>
          )}
          <form onSubmit={(e) => void onAdd(e)} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <TextInput
                label="Passkey name"
                id="passkey-name"
                value={name}
                maxLength={80}
                placeholder="For example: work laptop"
                error={error ?? undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy || !!support} data-testid="add-passkey">
              {busy ? 'Waiting for the passkey…' : 'Add a passkey'}
            </Button>
          </form>
          {support && <p className="text-xs text-subtle">{support}</p>}
        </div>
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? 'this passkey'}?`}
        description="The workstation is told to drop it if it has not trusted it yet. A passkey it already trusts stays until you run guildwise-runner passkey remove on the workstation."
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id, { onSettled: () => setRemoving(null) });
        }}
      />
    </Panel>
  );
}
