import { APP_ERROR_TEXT, type AppErrorCode, type OrgAppDto, type OrgAppsResponse } from '@aom/shared';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import {
  useAddOrgApp,
  useOrgAppRequest,
  useOrgApps,
  useRemoveOrgApp,
  useTestOrgApp,
} from '../../api/queries/org-apps.ts';
import { sealIntegration } from '../../lib/runner-seal.ts';
import { newId } from '../../lib/secure.ts';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  TextInput,
} from '../ui.tsx';

const sentence = (code?: string, message?: string) =>
  (code && APP_ERROR_TEXT[code as AppErrorCode]) || message || APP_ERROR_TEXT.unexpected;

const STATE_LABEL: Record<OrgAppDto['state'], string> = {
  connected: 'Connected',
  error: 'Error',
  pending: 'Pending',
};

/** Settings > Automated apps: every member sees the apps; only the Owner gets the actions (they are not rendered for others). */
export function AppsTab() {
  const apps = useOrgApps();
  const [adding, setAdding] = useState(false);
  if (apps.isPending) return <ListSkeleton />;
  if (apps.error) return <ErrorBox error={apps.error} />;
  const data = apps.data;
  return (
    <div className="space-y-4" data-testid="org-apps">
      <p className="text-sm text-muted">
        Automated apps (a GitHub App) give agents their own bot identity. The private key stays encrypted on
        the workstations you choose; tokens are minted there and kept in memory only.
      </p>
      {data.canManage && (
        <Button
          variant="primary"
          className="min-h-11"
          onClick={() => setAdding(true)}
          data-testid="org-apps-add"
        >
          Add app
        </Button>
      )}
      {data.apps.length === 0 ? (
        <EmptyState
          title="No automated apps"
          description="The organization Owner can add a GitHub App here."
        />
      ) : (
        data.apps.map((a) => <AppCard key={a.id} app={a} canManage={data.canManage} />)
      )}
      {data.canManage && adding && <AddAppDialog data={data} onClose={() => setAdding(false)} />}
    </div>
  );
}

function AppCard({ app, canManage }: { app: OrgAppDto; canManage: boolean }) {
  const test = useTestOrgApp();
  const remove = useRemoveOrgApp();
  const [confirm, setConfirm] = useState(false);
  return (
    <section className="rounded-lg border border-line p-4 space-y-2" data-testid="org-app-card">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{app.label}</h3>
        <Badge>{STATE_LABEL[app.state]}</Badge>
      </div>
      <p className="text-sm text-muted">
        GitHub App {app.appSlug} (App ID {app.appId}), installed on {app.account}
      </p>
      <p className="text-sm">
        Acts as <strong>{app.botLogin}</strong>; commits as{' '}
        <code data-testid="org-app-commit">
          {app.commitName} &lt;{app.commitEmail}&gt;
        </code>
      </p>
      {app.missingPermissions.length > 0 && (
        <Callout tone="warning">
          The installation does not grant: {app.missingPermissions.join(', ')}.
        </Callout>
      )}
      {app.workstations && (
        <ul className="text-sm space-y-1">
          {app.workstations.map((w) => (
            <li key={w.id}>
              {w.name} ({w.ownerName}): {w.state}
              {w.refreshedAt ? `, last token ${new Date(w.refreshedAt).toLocaleString()}` : ''}
              {w.state === 'error' ? `. ${sentence(w.errorCode, w.message)}` : ''}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button className="min-h-11" loading={test.isPending} onClick={() => test.mutate(app.id)}>
            Test
          </Button>
          <Button className="min-h-11" variant="danger" onClick={() => setConfirm(true)}>
            Remove
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${app.label}?`}
        description="The key is deleted on every workstation. Projects that post as this app fall back to their default."
        confirmLabel="Remove"
        onConfirm={() => remove.mutate(app.id)}
      />
    </section>
  );
}

/** The add dialog: the key is read from a file (or pasted), kept in a ref only, sealed per workstation and then cleared. */
export function AddAppDialog({ data, onClose }: { data: OrgAppsResponse; onClose: () => void }) {
  const add = useAddOrgApp();
  const key = useRef('');
  const [label, setLabel] = useState('');
  const [appRef, setAppRef] = useState('');
  const [installationId, setInstallationId] = useState('');
  const [host, setHost] = useState('github.com');
  const [paste, setPaste] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const targets = (data.targets ?? []).filter((t) => t.supported);
  const [picked, setPicked] = useState<string[]>(targets.filter((t) => t.online).map((t) => t.id));
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const req = useOrgAppRequest(requestId);
  useEffect(
    () => () => {
      key.current = '';
    },
    [],
  );

  const setKey = (v: string) => {
    key.current = v;
    setHasKey(/PRIVATE KEY-----/.test(v));
  };

  const submit = async (installation = installationId) => {
    setError(null);
    try {
      const shares = await Promise.all(
        targets
          .filter((t) => picked.includes(t.id))
          .map(async (t) => {
            const ref = newId();
            const envelope = await sealIntegration({
              key: { keyId: t.keyId, publicKey: t.publicKey },
              serverTime: data.serverTime,
              workstationId: t.id,
              ref,
              kind: 'github-app',
              instance: installation ? `${appRef}:${installation}` : appRef,
              op: 'connect',
              method: 'app_key',
              fields: { privateKey: key.current },
            });
            return { workstationId: t.id, ref, keyId: t.keyId, envelope };
          }),
      );
      const r = await add.mutateAsync({
        requestId: newId(),
        provider: 'github-app',
        label: label.trim() || 'GitHub App',
        host,
        appRef,
        ...(installation ? { installationId: installation } : {}),
        shares,
      });
      setRequestId(r.requestId);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const state = req.data?.state;
  const done = state === 'done';
  const close = () => {
    key.current = '';
    onClose();
  };
  useEffect(() => {
    if (done) key.current = '';
  }, [done]);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title="Add a GitHub App"
      description="Only the App ID, installation and bot identity reach Guildwise; the key is encrypted in this browser for each workstation."
    >
      <div className="space-y-3" data-testid="org-app-dialog">
        {error && <Callout tone="danger">{error}</Callout>}
        {done && req.data?.identity ? (
          <Callout tone="success">
            Connected as {req.data.identity.botLogin}; commits as {req.data.identity.commitName} &lt;
            {req.data.identity.commitEmail}&gt;. You can delete the downloaded .pem file now.
          </Callout>
        ) : null}
        {state === 'failed' || state === 'expired' ? (
          <Callout tone="danger">
            Nothing was saved.{' '}
            {(req.data?.results ?? []).map((r) => sentence(r.code, r.message)).join(' ') ||
              'The workstations did not answer in time.'}
          </Callout>
        ) : null}
        {state === 'needs_choice' && (
          <div className="space-y-2">
            <p className="text-sm">
              The app is installed on several accounts. Pick the one that owns the project repositories:
            </p>
            {(req.data?.installations ?? []).map((i) => (
              <Button
                key={i.id}
                className="min-h-11"
                disabled={i.suspended}
                onClick={() => {
                  setInstallationId(i.id);
                  void submit(i.id);
                }}
              >
                {i.account}
                {i.accountType ? ` (${i.accountType})` : ''}
                {i.suspended ? ' suspended' : ''}
              </Button>
            ))}
          </div>
        )}
        <TextInput label="Label" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
        <TextInput
          label="App ID or client ID"
          value={appRef}
          inputMode={/^\d*$/.test(appRef) ? 'numeric' : 'text'}
          onChange={(e) => setAppRef(e.target.value.trim())}
          onFocus={(e) => e.currentTarget.scrollIntoView?.({ block: 'center' })}
        />
        <TextInput
          label="Installation ID"
          hint="Leave empty to pick from the installations."
          inputMode="numeric"
          value={installationId}
          onChange={(e) => setInstallationId(e.target.value.trim())}
          onFocus={(e) => e.currentTarget.scrollIntoView?.({ block: 'center' })}
        />
        {!paste ? (
          <label className="block text-sm">
            Private key (.pem)
            <input
              type="file"
              accept=".pem"
              className="mt-1 block min-h-11"
              data-testid="org-app-key-file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void f.text().then(setKey);
              }}
            />
          </label>
        ) : (
          <label className="block text-sm">
            Private key
            <textarea
              className="mt-1 block w-full rounded border border-line p-2 font-mono text-xs"
              rows={6}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              data-testid="org-app-key-paste"
              onChange={(e) => setKey(e.target.value)}
              onFocus={(e) => e.currentTarget.scrollIntoView?.({ block: 'center' })}
            />
          </label>
        )}
        <Button variant="ghost" className="min-h-11" onClick={() => setPaste(!paste)}>
          {paste ? 'Choose a file instead' : 'Paste instead'}
        </Button>
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Workstations that may act as the app</legend>
          {(data.targets ?? []).map((t) => (
            <label key={t.id} className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={!t.supported}
                checked={picked.includes(t.id)}
                onChange={(e) =>
                  setPicked(e.target.checked ? [...picked, t.id] : picked.filter((x) => x !== t.id))
                }
              />
              {t.name} ({t.ownerName}){!t.supported ? ': update the runner' : t.online ? '' : ': offline'}
            </label>
          ))}
          <p className="text-xs text-muted">
            Anyone who controls one of these workstations can act as the app. Pick only workstations you trust
            with that.
          </p>
        </fieldset>
        <TextInput label="GitHub host" value={host} onChange={(e) => setHost(e.target.value.trim())} />
        <div className="flex flex-wrap gap-2 pt-2">
          <Button className="min-h-11" onClick={close}>
            {done ? 'Close' : 'Cancel'}
          </Button>
          {!done && (
            <Button
              variant="primary"
              className="min-h-11"
              data-testid="org-app-save"
              loading={add.isPending || state === 'pending'}
              disabled={!appRef || !hasKey || picked.length === 0}
              onClick={() => void submit()}
            >
              {state === 'pending'
                ? 'Checking with GitHub…'
                : `Encrypt for ${picked.length} workstation(s) and save`}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
