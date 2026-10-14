import { type IntegrationKind, isTerminalSessionState } from '@aom/shared';
import { useEffect, useRef, useState } from 'react';
import {
  integrationErrorMessage,
  isRequestTerminal,
  useCancelIntegrationSession,
  useIntegrationRequest,
  useSendSessionInput,
} from '../../api/queries/integrations.ts';
import type { PageCtx } from '../../lib/integrations.ts';
import { sealIntegration } from '../../lib/runner-seal.ts';
import { copyText } from '../../lib/secure.ts';
import { Button, Callout, ErrorBox, TextInput, useToast } from '../ui.tsx';

/** The runner accepts at most three pastes per session (`claude mcp login` keeps asking after a wrong address). */
export const MAX_PASTES = 3;

const safeUrl = (raw: string | undefined): string | null => {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
};

export const formatCountdown = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const STEP_OF: Record<string, 1 | 2 | 3> = {
  starting: 1,
  awaiting_user: 1,
  awaiting_code: 2,
  completing: 3,
};

/**
 * An interactive sign-in the runner drives: 1 open the link (the host shown prominently, the device code large), 2 paste
 * the code or the address you landed on (masked, sealed for the workstation), 3 finishing. A 10-minute countdown and a
 * Cancel. The page only ever sees what the runner extracted (URL, code, a state); raw CLI output stays on the machine.
 */
export function SignInSession({
  ctx,
  kind,
  instance,
  sessionId,
  onClose,
}: {
  ctx: PageCtx;
  kind: IntegrationKind;
  instance: string;
  sessionId: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const req = useIntegrationRequest(ctx.workstationId, sessionId);
  const send = useSendSessionInput(ctx.workstationId, sessionId);
  const cancel = useCancelIntegrationSession(ctx.workstationId, sessionId);
  const [value, setValue] = useState('');
  const [attempt, setAttempt] = useState(1);
  const [sealing, setSealing] = useState(false);
  const [sealError, setSealError] = useState<string | null>(null);
  const sentAt = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const r = req.data;
  const state = r?.state ?? 'starting';
  const terminal = isRequestTerminal(state) || isTerminalSessionState(state as never);
  useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [terminal]);

  const prompt = r?.prompt ?? null;
  const remaining = r ? Date.parse(r.expiresAt) - now : 10 * 60_000;
  const step = STEP_OF[state] ?? 1;
  const url = safeUrl(prompt?.url);
  const sentState = sentAt.current !== null && r?.updatedAt === sentAt.current;
  const retry = attempt > 1 && state === 'awaiting_code' && !sentState && !send.isPending && !sealing;
  const isRedirect = prompt?.inputKind === 'redirect_url';
  const label =
    prompt?.inputLabel ?? (isRedirect ? 'The address you landed on' : 'The code from the sign-in page');

  const submit = async () => {
    const key = ctx.page.key;
    if (!key || !value.trim()) return;
    setSealError(null);
    setSealing(true);
    try {
      const envelope = await sealIntegration({
        key,
        serverTime: ctx.page.serverTime,
        workstationId: ctx.workstationId,
        ref: `${sessionId}:${attempt}`,
        kind: kind.id,
        instance,
        op: 'input',
        fields: { value: value.trim() },
      });
      setValue('');
      sentAt.current = r?.updatedAt ?? '';
      await send.mutateAsync(envelope);
      setAttempt((n) => n + 1);
    } catch (e) {
      setValue('');
      sentAt.current = null;
      setSealError(integrationErrorMessage(e));
    } finally {
      setSealing(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="sign-in-session" data-state={state}>
      <div className="flex items-center justify-between text-xs text-subtle">
        <span>
          Step {Math.min(step, 3)} of 3 on {ctx.workstationName}
        </span>
        {!terminal && <span data-testid="session-countdown">{formatCountdown(remaining)} left</span>}
      </div>
      <ol className="flex flex-col gap-3 text-sm">
        <li
          className={step === 1 ? 'text-fg' : 'text-muted'}
          data-testid="step-1"
          aria-current={step === 1 ? 'step' : undefined}
        >
          <p className="font-medium">1. Open this link</p>
          {state === 'starting' && <p className="text-subtle">Preparing the sign-in on the workstation...</p>}
          {url && (
            <div className="mt-1 flex flex-col gap-2">
              {prompt?.urlHost && (
                <p data-testid="session-host">
                  You are signing in to <strong className="text-base">{prompt.urlHost}</strong>
                </p>
              )}
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="self-start rounded-control border border-control px-3 py-1.5 text-brand-text underline"
                data-testid="session-link"
              >
                Open the sign-in page
              </a>
            </div>
          )}
          {prompt?.userCode && (
            <div className="mt-2 flex items-center gap-3">
              <code
                className="rounded bg-sunken px-3 py-1.5 font-mono text-2xl tracking-widest"
                data-testid="session-code"
              >
                {prompt.userCode}
              </code>
              <Button
                size="sm"
                onClick={async () => {
                  if (await copyText(prompt.userCode ?? '')) toast.success('Code copied');
                }}
              >
                Copy
              </Button>
            </div>
          )}
          {prompt?.inputKind === 'none' && state === 'awaiting_user' && (
            <p className="mt-2 text-subtle">Approve the sign-in there. This page continues by itself.</p>
          )}
        </li>
        {prompt?.inputKind !== 'none' && (
          <li
            className={step === 2 ? 'text-fg' : 'text-muted'}
            data-testid="step-2"
            aria-current={step === 2 ? 'step' : undefined}
          >
            <p className="font-medium">2. Paste {isRedirect ? 'the address you landed on' : 'the code'}</p>
            {isRedirect && (
              <p className="text-subtle" data-testid="mcp-hint">
                After you sign in, the provider sends you to a localhost address. If this browser is not on
                the workstation that page shows an error such as &ldquo;This site can&rsquo;t be
                reached&rdquo;. That is expected: copy the whole address from the address bar and paste it
                here.
              </p>
            )}
            {state === 'awaiting_code' && (
              <form
                className="mt-2 flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                {retry && (
                  <p className="text-warning-soft-fg" role="status">
                    That did not work. Paste it again (attempt {attempt} of {MAX_PASTES}).
                  </p>
                )}
                <TextInput
                  label={label}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  disabled={sealing || send.isPending || sentState || attempt > MAX_PASTES}
                />
                <Button
                  type="submit"
                  variant="primary"
                  className="self-start"
                  loading={sealing || send.isPending}
                  disabled={!value.trim() || sentState || attempt > MAX_PASTES}
                >
                  {sealing ? `Encrypting for ${ctx.workstationName}...` : 'Send'}
                </Button>
                {sentState && <p className="text-subtle">Sent. Waiting for the workstation...</p>}
              </form>
            )}
          </li>
        )}
        <li
          className={step === 3 ? 'text-fg' : 'text-muted'}
          data-testid="step-3"
          aria-current={step === 3 ? 'step' : undefined}
        >
          <p className="font-medium">{prompt?.inputKind === 'none' ? '2' : '3'}. Finishing</p>
          {state === 'completing' && <p className="text-subtle">Checking with {kind.label}...</p>}
        </li>
      </ol>

      {state === 'connected' && (
        <Callout tone="success" role="status" data-testid="session-result">
          Connected{r?.status?.account ? ` as ${r.status.account}` : ''}.
        </Callout>
      )}
      {(state === 'failed' || state === 'expired' || state === 'cancelled') && (
        <Callout tone={state === 'cancelled' ? 'info' : 'danger'} role="alert" data-testid="session-result">
          {state === 'expired'
            ? 'The sign-in timed out. Start it again.'
            : state === 'cancelled'
              ? 'The sign-in was cancelled.'
              : (r?.error ?? 'The sign-in failed.')}
        </Callout>
      )}
      {sealError && <ErrorBox error={new Error(sealError)} />}
      <ErrorBox error={cancel.error ? new Error(integrationErrorMessage(cancel.error)) : null} />
      <div className="flex justify-end gap-2">
        {terminal ? (
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <Button
            variant="ghost"
            loading={cancel.isPending}
            onClick={() => cancel.mutate(undefined, { onSuccess: () => void req.refetch() })}
          >
            Cancel sign-in
          </Button>
        )}
      </div>
    </div>
  );
}
