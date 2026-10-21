import {
  type DeployKeyDto,
  type HostKeyEntry,
  hostKeyKind,
  type OpStatusDto,
  preferredHostKey,
  suggestAlias,
} from '@aom/shared';
import { ArrowLeft, Check, KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useConnect, useCreateKey, useOp, useStartHostKey } from '../../../api/queries/deploy-connect.ts';
import { useSetupState } from '../../../api/queries/deploy-setup.ts';
import { usePatchDeployTarget } from '../../../api/queries/phases.ts';
import { Badge, Button, Callout, ErrorBox, Select, Spinner, TextArea, TextInput } from '../../ui.tsx';
import { CopyButton } from './CopyButton.tsx';
import { KeysList } from './KeysList.tsx';

type Method = 'password' | 'keyfile' | 'panel';
type Step = 'where' | 'fingerprint' | 'how' | 'working' | 'done';

export interface ConnectedServer {
  targetId: string;
  alias: string;
  name: string;
  workstationId: string;
}

const METHOD_TEXT: Record<Method, { title: string; hint: string }> = {
  password: {
    title: 'With a password',
    hint: 'Your hosting company sent you a user name and a password. You type the password once.',
  },
  keyfile: {
    title: 'With a key file my host gave me',
    hint: 'Some hosts give you a file (it starts with -----BEGIN) instead of a password.',
  },
  panel: {
    title: 'My hosting panel has a place to paste a key',
    hint: 'Guildwise shows you a key to copy into the panel. No password is typed here.',
  },
};

/**
 * Guided connect for a server with no sign-in yet, and "Reconnect" from a new computer (docs/design/deploy-run-ux-design.md
 * J4 and J5): address and user, the server's fingerprint in plain words (confirmed before it is trusted), then a password
 * (used once, never stored), a key file, or a key to paste into a hosting panel, and a connection test. Guildwise adds its own
 * key to the server's list of allowed keys; it never edits the person's ssh files.
 */
export function ConnectServer({
  projectId,
  target,
  production = false,
  heading = true,
  prefill,
  onDone,
  onCancel,
}: {
  projectId: string;
  /** Reconnect: the existing server target (its deploying computer changes to the chosen one). */
  target?: {
    id: string;
    name: string;
    host: string | null;
    workstationId: string | null;
    keys?: DeployKeyDto[] | undefined;
  };
  production?: boolean;
  /** Show the title (off inside a dialog that has its own). */
  heading?: boolean;
  /** Fields to start with (a server this computer already knows by name). */
  prefill?: { name?: string; address?: string; user?: string; port?: number } | undefined;
  onDone: (s: ConnectedServer) => void;
  onCancel: () => void;
}) {
  const state = useSetupState(projectId);
  const mine = useMemo(
    () => (state.data?.workstations ?? []).filter((w) => w.mine && w.canConnect),
    [state.data],
  );
  const known = target?.keys?.find((k) => k.address) ?? null;
  const [step, setStep] = useState<Step>('where');
  const [wsId, setWsId] = useState('');
  const [name, setName] = useState(target?.name ?? prefill?.name ?? '');
  const [address, setAddress] = useState(known?.address ?? prefill?.address ?? '');
  const [user, setUser] = useState(known?.user ?? prefill?.user ?? 'root');
  const [port, setPort] = useState(String(known?.port ?? prefill?.port ?? 22));
  const [method, setMethod] = useState<Method>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [scanId, setScanId] = useState<string | null>(null);
  const [fp, setFp] = useState<HostKeyEntry | null>(null);
  const [fpCheck, setFpCheck] = useState<'matched' | 'skipped' | null>(null);
  const [keyOp, setKeyOp] = useState<string | null>(null);
  const [connectOp, setConnectOp] = useState<string | null>(null);
  const [created, setCreated] = useState<{ targetId: string; alias: string } | null>(null);
  const [keyRef] = useState(() => crypto.randomUUID());
  const [waitedLong, setWaitedLong] = useState(false);

  const chosen =
    wsId ||
    mine.find((w) => w.id === target?.workstationId && w.connected)?.id ||
    mine.find((w) => w.connected)?.id ||
    mine[0]?.id ||
    '';
  const ws = mine.find((w) => w.id === chosen);
  const startScan = useStartHostKey(projectId);
  const createKey = useCreateKey(projectId);
  const connect = useConnect(projectId);
  const patchTarget = usePatchDeployTarget(projectId);
  const scan = useOp(projectId, scanId);
  const keyResult = useOp(projectId, keyOp);
  const result = useOp(projectId, connectOp);

  const portNum = Number(port);
  const validWhere =
    !!chosen &&
    /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(address.trim()) &&
    /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user.trim()) &&
    Number.isInteger(portNum) &&
    portNum > 0 &&
    portNum < 65536 &&
    (!!target || name.trim().length > 0);

  // the fingerprint arrives
  const scanKeys =
    scan.data?.state === 'done' ? ((scan.data.result as { keys?: HostKeyEntry[] })?.keys ?? []) : [];
  useEffect(() => {
    if (step === 'fingerprint' && scanKeys.length && !fp) setFp(preferredHostKey(scanKeys) ?? null);
  }, [step, scanKeys, fp]);

  // the public key for a hosting panel is made when that way is chosen
  const publicKey =
    keyResult.data?.state === 'done'
      ? (keyResult.data.result as { publicKey?: string })?.publicKey
      : undefined;
  const askedKey = useRef(false);
  useEffect(() => {
    if (step !== 'how' || method !== 'panel' || askedKey.current || !chosen) return;
    askedKey.current = true;
    createKey.mutate(
      { workstationId: chosen, ...(target ? { targetId: target.id } : { keyRef }) },
      { onSuccess: (r) => setKeyOp(r.commandId) },
    );
  }, [step, method, chosen, target, keyRef, createKey]);

  // a long wait gets a sentence
  useEffect(() => {
    if (step !== 'working' && step !== 'fingerprint') return setWaitedLong(false);
    const t = setTimeout(() => setWaitedLong(true), 45_000);
    return () => clearTimeout(t);
  }, [step]);

  // the connection test answers
  const finished = result.data && result.data.state !== 'pending' ? result.data : null;
  useEffect(() => {
    if (step === 'working' && finished) {
      setStep(finished.ok ? 'done' : 'how');
      // a server that did not connect was not kept on the list (the copy-paste flow keeps it): the next try makes it again
      if (!finished.ok && !target && method !== 'panel') setCreated(null);
    }
  }, [step, finished, target, method]);

  const done = step === 'done' && created;
  const patched = useRef(false);
  useEffect(() => {
    // a replacement computer becomes the one that deploys this server
    if (!done || !target || patched.current || target.workstationId === chosen) return;
    patched.current = true;
    patchTarget.mutate({ id: target.id, body: { workstationId: chosen } });
  }, [done, target, chosen, patchTarget]);

  const begin = () => {
    setFp(null);
    setFpCheck(null);
    startScan.mutate(
      { workstationId: chosen, address: address.trim(), port: portNum },
      { onSuccess: (r) => setScanId(r.commandId) },
    );
    setStep('fingerprint');
  };

  const send = () => {
    if (!fp) return;
    const common = {
      workstationId: chosen,
      method,
      address: address.trim(),
      user: user.trim(),
      port: portNum,
      hostKeyFingerprint: fp.fingerprint,
      ...(method === 'panel' && !target && !created ? { keyRef } : {}),
      ...(method === 'panel' && created ? { keyRef } : {}),
    };
    const who = created
      ? { targetId: created.targetId }
      : target
        ? { targetId: target.id }
        : {
            newTarget: { name: name.trim(), production },
            alias: suggestAlias(name.trim()),
          };
    connect.mutate(
      {
        ...common,
        ...who,
        ...(method === 'password'
          ? { secret: { password } }
          : method === 'keyfile'
            ? { secret: { privateKey, ...(passphrase ? { passphrase } : {}) } }
            : {}),
      } as never,
      {
        onSuccess: (r) => {
          // the secret is not kept a moment longer than the request
          setPassword('');
          setPrivateKey('');
          setPassphrase('');
          setCreated({ targetId: r.targetId, alias: r.alias });
          setConnectOp(r.commandId);
          setStep('working');
        },
      },
    );
  };

  if (state.isPending) return <Spinner label="Loading" />;
  if (mine.length === 0)
    return (
      <Callout tone="warning" title="No computer of yours can do this yet" data-testid="connect-no-computer">
        {(state.data?.workstations ?? []).find((w) => w.mine && !w.canConnect)?.blocked ??
          'Connect Guildwise on one of your computers first (it signs in to the server for you).'}
        <div className="mt-2">
          <Button size="sm" onClick={onCancel}>
            Back
          </Button>
        </div>
      </Callout>
    );

  const needsSecret =
    (method === 'password' && !password) || (method === 'keyfile' && privateKey.trim().length < 40);
  const otherKeys = (target?.keys ?? []).filter((k) => k.state === 'active' && k.workstationId !== chosen);

  return (
    <div className="flex flex-col gap-4" data-testid="connect-server" data-step={step}>
      <div>
        <button
          type="button"
          onClick={() =>
            step === 'where' || step === 'done'
              ? onCancel()
              : setStep(step === 'how' ? 'fingerprint' : 'where')
          }
          className="mb-1 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
          data-testid="connect-back"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {step === 'where' || step === 'done' ? 'Cancel' : 'Back'}
        </button>
        {heading && (
          <h3 className="text-lg font-semibold text-fg">
            {target ? `Reconnect to ${target.name}` : 'Connect a different server'}
          </h3>
        )}
      </div>

      {step === 'where' && (
        <section className="flex flex-col gap-3" data-testid="connect-where">
          <p className="text-sm text-muted">
            Guildwise signs in to your server from one of your computers and adds its own key, so updates
            never need your password again.
          </p>
          {mine.length > 1 && (
            <Select
              label="Which computer signs in?"
              value={chosen}
              onChange={(e) => setWsId(e.target.value)}
              data-testid="connect-computer"
            >
              {mine.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.connected ? '' : ' (offline)'}
                </option>
              ))}
            </Select>
          )}
          {mine.length === 1 && (
            <p className="text-sm text-muted">
              It signs in from <strong>{ws?.name}</strong>.
            </p>
          )}
          {!target && (
            <TextInput
              label="What do you call this server?"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Live site server"
              data-testid="connect-name"
            />
          )}
          <TextInput
            label="Server address"
            hint="A name like shop.example.com or numbers like 203.0.113.9. Your hosting company's email has it."
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-testid="connect-address"
          />
          <TextInput
            label="User name"
            hint="Usually root. Your hosting company's email says."
            value={user}
            onChange={(e) => setUser(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-testid="connect-user"
          />
          <details>
            <summary className="cursor-pointer text-sm text-muted">The server uses a different port</summary>
            <div className="mt-2">
              <TextInput
                label="Port"
                inputMode="numeric"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                data-testid="connect-port"
              />
            </div>
          </details>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-fg">How do you sign in to it?</legend>
            {(Object.keys(METHOD_TEXT) as Method[]).map((m) => (
              <label
                key={m}
                className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-control border p-3 ${
                  method === m ? 'border-brand bg-brand-soft ring-1 ring-brand' : 'border-control bg-surface'
                }`}
              >
                <input
                  type="radio"
                  name="connect-method"
                  className="mt-1 size-4"
                  checked={method === m}
                  onChange={() => setMethod(m)}
                  data-testid={`connect-method-${m}`}
                />
                <span>
                  <span className="block text-sm font-semibold text-fg">{METHOD_TEXT[m].title}</span>
                  <span className="block text-sm text-muted">{METHOD_TEXT[m].hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <ErrorBox error={startScan.error} />
          <div className="sticky bottom-[var(--app-bottom-inset,0px)] z-10 -mx-4 flex gap-2 border-t border-line bg-surface px-4 py-3 sm:mx-0">
            <Button onClick={onCancel}>Cancel</Button>
            <Button
              variant="primary"
              className="flex-1 sm:flex-none"
              disabled={!validWhere || startScan.isPending || ws?.connected === false}
              loading={startScan.isPending}
              onClick={begin}
              data-testid="connect-continue"
            >
              Continue
            </Button>
          </div>
          {ws?.connected === false && (
            <p className="text-xs text-warning">
              {ws.name} is offline. Start Guildwise on it, then continue.
            </p>
          )}
        </section>
      )}

      {step === 'fingerprint' && (
        <section className="flex flex-col gap-3" data-testid="connect-fingerprint">
          {!fp && scan.data?.state !== 'failed' && scan.data?.state !== 'expired' && (
            <div className="flex items-center gap-2 text-sm text-muted" role="status">
              <Spinner inline label="Asking" />
              Asking {address} for its fingerprint from {ws?.name}...
            </div>
          )}
          {waitedLong && !fp && (
            <p className="text-sm text-warning">Still waiting for {ws?.name}. Is Guildwise running on it?</p>
          )}
          {(scan.data?.state === 'failed' || scan.data?.state === 'expired') && (
            <Callout tone="danger" title="Could not reach the server" data-testid="connect-scan-error">
              {scan.data.errorText}
              <div className="mt-2">
                <Button size="sm" onClick={() => setStep('where')}>
                  Change the address
                </Button>
              </div>
            </Callout>
          )}
          {fp && (
            <>
              <div className="rounded-control border border-line p-3">
                <p className="flex items-center gap-2 text-sm text-fg">
                  <ShieldCheck aria-hidden="true" className="size-4 text-muted" />
                  Is this your server?
                </p>
                <p className="mt-1 text-sm text-muted">
                  The server at <strong>{address}</strong> says its fingerprint is:
                </p>
                <p
                  className="mt-2 font-mono text-sm font-semibold text-fg [overflow-wrap:anywhere]"
                  data-testid="connect-fp"
                >
                  {fp.fingerprint}
                </p>
                <p className="mt-1 text-xs text-subtle">
                  This is the server's own ID ({hostKeyKind(fp.type)}). If your hosting company shows a
                  fingerprint (in its panel or in the welcome email), check that it is the same.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  variant="primary"
                  onClick={() => {
                    setFpCheck('matched');
                    setStep('how');
                  }}
                  data-testid="connect-fp-matches"
                >
                  <Check aria-hidden="true" className="size-4" />
                  It matches
                </Button>
                <Button
                  onClick={() => {
                    setFpCheck('skipped');
                    setStep('how');
                  }}
                  data-testid="connect-fp-skip"
                >
                  I can't check, continue
                </Button>
                <Button variant="ghost" onClick={() => setStep('where')} data-testid="connect-fp-no">
                  This is not it
                </Button>
              </div>
              <p className="text-xs text-subtle">
                If you continue without checking, anyone between you and the server could pretend to be it.
                That is very rare, but checking is safer.
              </p>
            </>
          )}
        </section>
      )}

      {step === 'how' && fp && (
        <section className="flex flex-col gap-3" data-testid="connect-how">
          {fpCheck === 'skipped' && (
            <Badge tone="amber" data-testid="connect-unchecked">
              Fingerprint not checked
            </Badge>
          )}
          {finished && !finished.ok && (
            <Callout tone="danger" title="That did not work" data-testid="connect-error">
              {finished.errorText}
            </Callout>
          )}
          {method === 'password' && (
            <>
              <Callout
                tone="info"
                title="What happens to your password"
                data-testid="connect-password-promise"
              >
                <ul className="list-disc pl-4">
                  <li>
                    You type it once, here. It is sealed in your browser so only {ws?.name} can read it.
                  </li>
                  <li>
                    {ws?.name} uses it one time to add a new Guildwise key to {address}.
                  </li>
                  <li>Then it is dropped. Guildwise never stores it and never writes it in a log.</li>
                </ul>
              </Callout>
              <TextInput
                label={`Password for ${user}`}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                data-testid="connect-password"
              />
            </>
          )}
          {method === 'keyfile' && (
            <>
              <Callout
                tone="info"
                title="What happens to your key file"
                data-testid="connect-keyfile-promise"
              >
                <ul className="list-disc pl-4">
                  <li>
                    It is sealed in your browser so only {ws?.name} can read it, and used once to sign in.
                  </li>
                  <li>
                    Guildwise adds its own new key to {address}, then forgets your file. It is never stored.
                  </li>
                </ul>
              </Callout>
              <TextArea
                label="The key file"
                hint="Open the file in a text editor and paste everything, from -----BEGIN to -----END."
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                rows={6}
                spellCheck={false}
                className="font-mono text-xs"
                data-testid="connect-keyfile"
              />
              <TextInput
                label="Passphrase (only if the file has one)"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="off"
                data-testid="connect-passphrase"
              />
            </>
          )}
          {method === 'panel' && (
            <>
              {!publicKey && (
                <div className="flex items-center gap-2 text-sm text-muted" role="status">
                  <Spinner inline label="Making the key" />
                  {ws?.name} is making a key for this server...
                </div>
              )}
              <ErrorBox error={createKey.error} />
              {keyResult.data && keyResult.data.state !== 'pending' && !publicKey && (
                <p className="text-sm text-danger">
                  {keyResult.data.errorText ?? 'The key could not be made.'}
                </p>
              )}
              {publicKey && (
                <div className="flex flex-col gap-3" data-testid="connect-panel-key">
                  <ol className="list-decimal pl-5 text-sm text-fg">
                    <li>Copy this key.</li>
                    <li>
                      Open your hosting company's panel and look for <em>SSH keys</em> (sometimes{' '}
                      <em>Authorized keys</em>).
                    </li>
                    <li>Add a new key, paste this one in, and save.</li>
                    <li>Come back here and press the button below.</li>
                  </ol>
                  <div className="rounded-control border border-line bg-sunken p-3">
                    <p
                      className="font-mono text-xs [overflow-wrap:anywhere]"
                      data-testid="connect-public-key"
                    >
                      {publicKey}
                    </p>
                    <div className="mt-2">
                      <CopyButton text={publicKey} label="Copy the key" testId="connect-copy" />
                    </div>
                  </div>
                  <p className="text-xs text-subtle">
                    This is the public half. It cannot be used to sign in by itself; the private half stays on{' '}
                    {ws?.name}.
                  </p>
                </div>
              )}
            </>
          )}
          {method !== 'panel' && (
            <p className="flex items-start gap-2 text-xs text-subtle" data-testid="connect-exact-change">
              <Lock aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
              <span>
                The only change on the server: one line is added to the list of allowed keys of{' '}
                <strong>{user}</strong> (<code>~/.ssh/authorized_keys</code>), after a dated copy of that
                list. Nothing else is touched.
              </span>
            </p>
          )}
          <ErrorBox error={connect.error} />
          <div className="sticky bottom-[var(--app-bottom-inset,0px)] z-10 -mx-4 flex gap-2 border-t border-line bg-surface px-4 py-3 sm:mx-0">
            <Button onClick={() => setStep('fingerprint')}>Back</Button>
            <Button
              variant="primary"
              className="flex-1 sm:flex-none"
              disabled={needsSecret || (method === 'panel' && !publicKey) || connect.isPending}
              loading={connect.isPending}
              onClick={send}
              data-testid="connect-go"
            >
              <KeyRound aria-hidden="true" className="size-4" />
              {method === 'panel' ? 'I pasted it, test the connection' : 'Connect'}
            </Button>
          </div>
        </section>
      )}

      {step === 'working' && (
        <section className="flex flex-col gap-3" data-testid="connect-working">
          <div className="flex items-center gap-2 text-sm text-muted" role="status">
            <Spinner inline label="Connecting" />
            {method === 'panel' ? 'Testing the connection...' : `${ws?.name} is connecting and testing...`}
          </div>
          {waitedLong && (
            <p className="text-sm text-warning">
              This takes longer than usual. Is {ws?.name} running Guildwise?
            </p>
          )}
          {result.data?.state === 'expired' && (
            <Callout tone="danger" title="Nothing happened">
              {result.data.errorText}
            </Callout>
          )}
        </section>
      )}

      {done && (
        <section className="flex flex-col gap-3" data-testid="connect-done">
          <Callout tone="success" title="Connected">
            {ws?.name} can sign in to <strong>{address}</strong> with its own Guildwise key. The connection
            test worked.{' '}
            {(finished?.result as { installed?: string } | undefined)?.installed === 'already'
              ? 'The key was already on the server.'
              : ''}
          </Callout>
          {target && otherKeys.length > 0 && (
            <div className="flex flex-col gap-2" data-testid="connect-old-keys">
              <p className="text-sm text-fg">
                <strong>{otherKeys.map((k) => k.workstationName).join(', ')}</strong>{' '}
                {otherKeys.length === 1 ? 'still has' : 'still have'} a Guildwise key that the server accepts.
                If that computer is gone, remove its key.
              </p>
              <KeysList
                projectId={projectId}
                targetId={target.id}
                keys={otherKeys}
                signInWorkstationId={chosen}
              />
            </div>
          )}
          <ErrorBox error={patchTarget.error} />
          <div>
            <Button
              variant="primary"
              onClick={() =>
                created &&
                onDone({
                  targetId: created.targetId,
                  alias: created.alias,
                  name: target?.name ?? name.trim(),
                  workstationId: chosen,
                })
              }
              data-testid="connect-finish"
            >
              Continue
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

export type { OpStatusDto };
