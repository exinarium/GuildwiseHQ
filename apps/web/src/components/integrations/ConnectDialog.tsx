import {
  type IntegrationField,
  type IntegrationKind,
  type IntegrationMethod,
  integrationScope,
  validIntegrationInstance,
} from '@aom/shared';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import {
  integrationErrorMessage,
  isRequestTerminal,
  useBeginIntegrationSession,
  useConnectIntegration,
  useIntegrationRequest,
  useRefreshIntegrations,
} from '../../api/queries/integrations.ts';
import { blockReason, type PageCtx } from '../../lib/integrations.ts';
import { sealIntegration } from '../../lib/runner-seal.ts';
import { Button, Callout, Dialog, ErrorBox, TextInput } from '../ui.tsx';
import { SignInSession } from './SignInSession.tsx';

const inputType = (f: IntegrationField): string =>
  f.type === 'secret' ? 'password' : f.type === 'email' ? 'email' : f.type === 'url' ? 'url' : 'text';

/** The steps, scopes and links of one method (also used by the tile's "How to set it up"). */
export function MethodSteps({ method }: { method: IntegrationMethod }) {
  return (
    <div className="text-sm text-muted">
      <ol className="list-decimal space-y-1 pl-5">
        {method.steps.map((s) => (
          <li key={s.text}>
            {s.text}
            {s.link && (
              <>
                {' '}
                <a
                  href={s.link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand-text underline"
                >
                  {s.link.label}
                </a>
              </>
            )}
          </li>
        ))}
      </ol>
      {method.scopes && method.scopes.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-subtle">Scopes</p>
          <ul className="list-disc pl-5">
            {method.scopes.map((s) => (
              <li key={s.name}>
                <code className="font-mono text-xs">{s.name}</code> - {s.why}
                {s.required ? '' : ' (optional)'}
              </li>
            ))}
          </ul>
        </div>
      )}
      {method.expiry && <p className="mt-2 text-xs text-subtle">{method.expiry}</p>}
    </div>
  );
}

const newId = (): string => crypto.randomUUID();

/**
 * Connect or replace one integration. Fields methods: the values are sealed in the browser for this workstation's runner
 * (the button reads "Encrypting for <workstation>...", then "Checking with <provider>...") and only the envelope is sent.
 * Interactive methods start a runner-driven sign-in (SignInSession). Values live in this component's state only and are
 * cleared the moment they are sealed.
 */
export function ConnectDialog({
  open,
  onOpenChange,
  ctx,
  kind,
  instance: presetInstance,
  initialMethod,
  resumeSessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ctx: PageCtx;
  kind: IntegrationKind;
  /** The instance to connect; `null` asks for it (a new host or organization). */
  instance: string | null;
  initialMethod?: string | undefined;
  /** A sign-in already running for this tile: show it. */
  resumeSessionId?: string | undefined;
}) {
  const defaultInstance = typeof kind.instances === 'object' ? (kind.instances.defaultInstance ?? '') : '';
  const [instanceInput, setInstanceInput] = useState(presetInstance ?? defaultInstance);
  // "Sign in with your Claude subscription" needs an account key: it is not offered for the main account.
  const methods = kind.methods.filter((m) => m.id !== 'claude_login' || instanceInput.trim() !== '');
  const first = methods.find((m) => !m.phase) ?? methods[0];
  const [methodId, setMethodId] = useState(initialMethod ?? first?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<'form' | 'sealing' | 'checking'>('form');
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(resumeSessionId ?? null);
  const connect = useConnectIntegration(ctx.workstationId);
  const begin = useBeginIntegrationSession(ctx.workstationId);
  const refresh = useRefreshIntegrations(ctx.workstationId);
  const result = useIntegrationRequest(ctx.workstationId, requestId);

  // Nothing typed survives the dialog closing.
  useEffect(() => {
    if (!open) {
      setValues({});
      setStage('form');
      setError(null);
      setRequestId(null);
      setSessionId(resumeSessionId ?? null);
    }
  }, [open, resumeSessionId]);

  const method = methods.find((m) => m.id === methodId) ?? first;
  if (!method) return null;
  const instance = instanceInput.trim();
  const multi = kind.instances !== 'single';
  const askInstance = multi && presetInstance === null;
  const scope = integrationScope(kind, method.id);
  const block = blockReason(ctx, kind, scope, instance);
  // A named Claude account is a key; leaving it empty would mean the main account, which has its own tile.
  const instanceOk =
    validIntegrationInstance(kind, multi ? instance : '') &&
    !(askInstance && kind.id === 'claude-code' && instance === '');
  const missing = (method.fields ?? []).some((f) => f.required && !(values[f.key] ?? '').trim());
  const rState = result.data?.state;
  const checking = stage === 'checking' && !isRequestTerminal(rState);
  const editable = stage === 'form' || (stage === 'checking' && !checking);

  const submitFields = async () => {
    const key = ctx.page.key;
    if (!key) {
      setError('This workstation has not announced its encryption key yet. Try again in a moment.');
      return;
    }
    setError(null);
    setStage('sealing');
    const id = newId();
    try {
      const fields: Record<string, string> = {};
      for (const f of method.fields ?? []) {
        const v = (values[f.key] ?? '').trim();
        if (v) fields[f.key] = v;
      }
      const envelope = await sealIntegration({
        key,
        serverTime: ctx.page.serverTime,
        workstationId: ctx.workstationId,
        ref: id,
        kind: kind.id,
        instance: multi ? instance : '',
        op: 'connect',
        method: method.id,
        fields,
      });
      setValues({});
      await connect.mutateAsync({
        requestId: id,
        kind: kind.id,
        instance: multi ? instance : '',
        method: method.id,
        envelope,
      });
      setRequestId(id);
      setStage('checking');
    } catch (e) {
      setValues({});
      setStage('form');
      if (e instanceof ApiError && e.code === 'runner_key_changed') refresh();
      setError(integrationErrorMessage(e));
    }
  };

  const startSession = async () => {
    setError(null);
    try {
      const r = await begin.mutateAsync({
        kind: kind.id,
        instance: multi ? instance : '',
        method: method.id,
      });
      setSessionId(r.id);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'runner_key_changed') refresh();
      setError(integrationErrorMessage(e));
    }
  };

  const title = `Connect ${kind.label}${instance && multi ? ` (${instance})` : ''}`;
  const failed = rState === 'failed' || rState === 'expired';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={`${kind.help.summary} Stored on ${ctx.workstationName}.`}
      size="lg"
      dismissible={!sessionId && stage === 'form'}
    >
      <div className="flex flex-col gap-4" data-testid={`connect-dialog-${kind.id}`}>
        {sessionId ? (
          <SignInSession
            ctx={ctx}
            kind={kind}
            instance={multi ? instance : ''}
            sessionId={sessionId}
            onClose={() => onOpenChange(false)}
          />
        ) : rState === 'done' ? (
          <>
            <Callout tone="success" role="status" data-testid="connect-result">
              Connected{result.data?.status?.account ? ` as ${result.data.status.account}` : ''}.
            </Callout>
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <>
            {methods.length > 1 && (
              <fieldset className="flex flex-col gap-2" disabled={!editable}>
                <legend className="mb-1 text-sm font-medium text-fg">How do you want to connect?</legend>
                {methods.map((m, i) => (
                  <label
                    key={m.id}
                    className={`flex items-start gap-2 text-sm ${m.phase ? 'text-disabled-fg' : 'text-fg'}`}
                  >
                    <input
                      type="radio"
                      name="method"
                      value={m.id}
                      checked={m.id === method.id}
                      disabled={!!m.phase}
                      onChange={() => {
                        setMethodId(m.id);
                        setValues({});
                      }}
                      className="mt-1"
                    />
                    <span>
                      {m.label}
                      {i === 0 && !m.phase && <span className="ml-1 text-xs text-subtle">(recommended)</span>}
                      {m.phase && <span className="ml-1 text-xs">(later)</span>}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {method.warning && (
              <Callout tone="warning" data-testid="method-warning">
                {method.warning}
              </Callout>
            )}
            {askInstance && (
              <TextInput
                label={typeof kind.instances === 'object' ? kind.instances.label : 'Name'}
                placeholder={typeof kind.instances === 'object' ? kind.instances.placeholder : ''}
                value={instanceInput}
                onChange={(e) => setInstanceInput(e.target.value)}
                disabled={!editable}
                autoComplete="off"
                spellCheck={false}
              />
            )}
            <MethodSteps method={method} />
            {method.flow === 'local_only' ? (
              <p className="text-sm text-muted" data-testid="local-only">
                This one is set up on the workstation itself; the steps above show how.
              </p>
            ) : method.flow === 'fields' ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitFields();
                }}
              >
                {(method.fields ?? []).map((f) => (
                  <TextInput
                    key={f.key}
                    label={f.label + (f.required ? '' : ' (optional)')}
                    type={inputType(f)}
                    placeholder={f.placeholder}
                    maxLength={f.maxLength}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    disabled={!editable}
                    {...(f.help ? { hint: f.help } : {})}
                    {...(f.type === 'secret'
                      ? { autoComplete: 'off', spellCheck: false, name: `secret-${f.key}` }
                      : { autoComplete: 'off', spellCheck: false })}
                  />
                ))}
                {block && (
                  <p className="text-sm text-muted" data-testid="connect-blocked">
                    {block}
                  </p>
                )}
                {failed && (
                  <Callout tone="danger" role="alert" data-testid="connect-result">
                    {result.data?.error ??
                      result.data?.status?.detail ??
                      (rState === 'expired' ? 'The request timed out.' : `${kind.label} refused it.`)}
                  </Callout>
                )}
                <ErrorBox error={error ? new Error(error) : null} />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={!editable}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    loading={stage === 'sealing' || checking}
                    disabled={!!block || missing || !instanceOk || stage === 'sealing' || checking}
                  >
                    {stage === 'sealing'
                      ? `Encrypting for ${ctx.workstationName}...`
                      : checking
                        ? `Checking with ${kind.label}...`
                        : 'Connect'}
                  </Button>
                </div>
                <p className="text-xs text-subtle">
                  Encrypted in this browser for {ctx.workstationName}; the server only relays ciphertext.
                </p>
              </form>
            ) : (
              <>
                {block && (
                  <p className="text-sm text-muted" data-testid="connect-blocked">
                    {block}
                  </p>
                )}
                <ErrorBox error={error ? new Error(error) : null} />
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => onOpenChange(false)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    loading={begin.isPending}
                    disabled={!!block || !instanceOk || begin.isPending}
                    onClick={() => void startSession()}
                  >
                    Start sign-in
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
