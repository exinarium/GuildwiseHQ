import type { StorageConnectionDto } from '@aom/shared';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { useWorkstationIntegrations } from '../../api/queries/integrations.ts';
import {
  REQUEST_DONE,
  useBeginStorageAuth,
  useCancelStorageAuth,
  useConnectStorage,
  useStorageRequest,
} from '../../api/queries/storage.ts';
import { useVaults } from '../../api/queries/vaults.ts';
import { sealIntegration } from '../../lib/runner-seal.ts';
import { canSealHere, copyText, newId } from '../../lib/secure.ts';
import { isOAuthKind, STORAGE_KIND_HELP, STORAGE_KIND_LABEL, storageErrorText } from '../../lib/storage.ts';
import { Button, Callout, Dialog, Select, Spinner, TextInput } from '../ui.tsx';

/** The device sign-in: a large code to type on any device, a link to the provider's page, and what is happening. */
function DevicePanel({ rid, onDone }: { rid: string; onDone: () => void }) {
  const req = useStorageRequest(rid);
  const r = req.data;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (r?.state === 'done') onDone();
  }, [r?.state, onDone]);
  if (!r || (r.state === 'pending' && !r.prompt))
    return <Spinner label="Asking your workstation for a sign-in code" />;
  if (r.state === 'failed' || r.state === 'expired' || r.state === 'cancelled')
    return (
      <Callout tone="danger" data-testid="storage-device-error">
        {r.state === 'cancelled' ? 'The sign-in was cancelled.' : storageErrorText(r.errorCode, r.message)}
      </Callout>
    );
  return (
    <div className="space-y-3 text-center" data-testid="storage-device-panel">
      <p className="text-sm text-muted">Open the sign-in page on any device and enter this code:</p>
      <p
        className="select-all text-3xl font-semibold tracking-widest text-fg"
        data-testid="storage-device-code"
      >
        {r.prompt?.userCode}
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          onClick={() => {
            void copyText(r.prompt?.userCode ?? '').then(setCopied);
          }}
        >
          {copied ? 'Copied' : 'Copy code'}
        </Button>
        {r.prompt?.verificationUri && (
          <a
            href={r.prompt.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center rounded-control border border-control px-4 text-sm font-medium text-brand"
          >
            Open sign-in page
          </a>
        )}
      </div>
      <p className="text-sm text-muted">Waiting for you to sign in…</p>
    </div>
  );
}

/** A request that was sent with sealed values: shows its progress and result. */
function RequestResult({ rid, onDone }: { rid: string; onDone: () => void }) {
  const req = useStorageRequest(rid);
  const r = req.data;
  useEffect(() => {
    if (r?.state === 'done') onDone();
  }, [r?.state, onDone]);
  if (!r || !REQUEST_DONE.includes(r.state))
    return <Spinner label="Testing the connection on your workstation" />;
  if (r.state !== 'done')
    return (
      <Callout tone="danger" data-testid="storage-connect-error">
        {storageErrorText(r.errorCode, r.message)}
      </Callout>
    );
  return <Callout tone="success">Connected.</Callout>;
}

/**
 * Step 2 of adding a connection, and the Reconnect action. OAuth kinds start the device sign-in; the other kinds seal the
 * typed values for the workstation (they never enter a query key, a mutation variable or the cache).
 */
export function StorageConnectDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: StorageConnectionDto | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const id = connection?.id ?? '';
  const kind = connection?.kind ?? 'local';
  const ws = useWorkstationIntegrations(open ? connection?.workstation.id : undefined);
  const vaults = useVaults();
  const connect = useConnectStorage(id);
  const begin = useBeginStorageAuth(id);
  const cancel = useCancelStorageAuth(id);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [rid, setRid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    if (!open) {
      setFields({});
      setRid(null);
      setError(null);
    }
  }, [open]);

  const close = () => {
    if (rid && isOAuthKind(kind)) cancel.mutate(rid);
    onOpenChange(false);
  };

  const startAuth = async () => {
    setError(null);
    try {
      const r = await begin.mutateAsync({
        ...(fields.siteUrl ? { siteUrl: fields.siteUrl } : {}),
        ...(fields.baseFolder ? { baseFolder: fields.baseFolder } : {}),
      });
      setRid(r.sessionId);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const sendSealed = async () => {
    if (!connection || !ws.data) return;
    setError(null);
    try {
      const requestId = newId();
      const envelope = await sealIntegration({
        key: ws.data.key as never,
        serverTime: ws.data.serverTime,
        workstationId: connection.workstation.id,
        ref: requestId,
        kind: 'storage' as never,
        instance: connection.id,
        op: 'connect',
        fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '')),
      });
      // The values are cleared from this component before the request leaves.
      setFields({});
      await connect.mutateAsync({ requestId, envelope: envelope as unknown as Record<string, unknown> });
      setRid(requestId);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const vaultList = useMemo(() => vaults.data ?? [], [vaults.data]);
  const canSeal = !!ws.data?.key && canSealHere();

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
      title={connection ? `Connect ${connection.label}` : 'Connect storage'}
      description={STORAGE_KIND_HELP[kind]}
      footer={
        <>
          <Button onClick={close}>{rid ? 'Close' : 'Cancel'}</Button>
          {!rid && isOAuthKind(kind) && (
            <Button
              variant="primary"
              loading={begin.isPending}
              onClick={() => void startAuth()}
              data-testid="storage-signin"
            >
              Get sign-in code
            </Button>
          )}
          {!rid && !isOAuthKind(kind) && (
            <Button
              variant="primary"
              disabled={!canSeal}
              loading={connect.isPending}
              onClick={() => void sendSealed()}
              data-testid="storage-seal-connect"
            >
              Connect
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3" data-testid="storage-connect-dialog">
        <p className="text-sm text-muted">
          {STORAGE_KIND_LABEL[kind]} on {connection?.workstation.name}
        </p>
        {error && <Callout tone="danger">{error}</Callout>}
        {rid && isOAuthKind(kind) && <DevicePanel rid={rid} onDone={() => onOpenChange(false)} />}
        {rid && !isOAuthKind(kind) && <RequestResult rid={rid} onDone={() => onOpenChange(false)} />}
        {!rid && kind === 'onedrive' && (
          <>
            <TextInput
              label="SharePoint site address (optional)"
              inputMode="url"
              autoComplete="off"
              placeholder="https://contoso.sharepoint.com/sites/team"
              value={fields.siteUrl ?? ''}
              onChange={(e) => set('siteUrl', e.target.value)}
            />
            <TextInput
              label="Folder name"
              autoComplete="off"
              placeholder="Guildwise uploads"
              value={fields.baseFolder ?? ''}
              onChange={(e) => set('baseFolder', e.target.value)}
            />
          </>
        )}
        {!rid && kind === 'google_drive' && (
          <TextInput
            label="Folder name"
            hint="Guildwise creates this folder and can only see what is inside it."
            autoComplete="off"
            placeholder="Guildwise uploads"
            value={fields.baseFolder ?? ''}
            onChange={(e) => set('baseFolder', e.target.value)}
          />
        )}
        {!rid && kind === 's3' && (
          <>
            <TextInput
              label="Endpoint"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://s3.eu-west-1.amazonaws.com"
              value={fields.endpoint ?? ''}
              onChange={(e) => set('endpoint', e.target.value)}
            />
            <TextInput
              label="Region"
              autoComplete="off"
              spellCheck={false}
              placeholder="eu-west-1"
              value={fields.region ?? ''}
              onChange={(e) => set('region', e.target.value)}
            />
            <TextInput
              label="Bucket"
              autoComplete="off"
              spellCheck={false}
              value={fields.bucket ?? ''}
              onChange={(e) => set('bucket', e.target.value)}
            />
            <TextInput
              label="Folder prefix (optional)"
              autoComplete="off"
              spellCheck={false}
              value={fields.prefix ?? ''}
              onChange={(e) => set('prefix', e.target.value)}
            />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={fields.pathStyle === 'true'}
                onChange={(e) => set('pathStyle', e.target.checked ? 'true' : '')}
              />
              Use path-style addresses (MinIO and most self-hosted stores)
            </label>
            <TextInput
              label="Access key id"
              autoComplete="off"
              spellCheck={false}
              value={fields.accessKeyId ?? ''}
              onChange={(e) => set('accessKeyId', e.target.value)}
            />
            <TextInput
              label="Secret access key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={fields.secretAccessKey ?? ''}
              onChange={(e) => set('secretAccessKey', e.target.value)}
            />
          </>
        )}
        {!rid && kind === 'local' && (
          <TextInput
            label="Folder on the workstation"
            hint="An absolute path, for example /srv/clients or \\\\nas\\clients"
            autoComplete="off"
            spellCheck={false}
            value={fields.root ?? ''}
            onChange={(e) => set('root', e.target.value)}
          />
        )}
        {!rid && kind === 'vault' && (
          <>
            <Select
              label="Vault"
              value={fields.vaultId ?? ''}
              onChange={(e) => set('vaultId', e.target.value)}
            >
              <option value="">Choose a vault</option>
              {vaultList.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
            <TextInput
              label="Folder inside the vault"
              autoComplete="off"
              spellCheck={false}
              placeholder="client-documents"
              value={fields.folder ?? ''}
              onChange={(e) => set('folder', e.target.value)}
            />
          </>
        )}
        {!rid && !isOAuthKind(kind) && !canSealHere() && (
          <Callout tone="warning" data-testid="storage-insecure-context">
            This page is not on HTTPS, so the browser cannot encrypt these details for your workstation. Open
            Guildwise over HTTPS or on localhost to connect this storage.
          </Callout>
        )}
        {!rid && !isOAuthKind(kind) && canSealHere() && !ws.data?.key && ws.isPending && (
          <Spinner label="Reading the workstation key" />
        )}
      </div>
    </Dialog>
  );
}
