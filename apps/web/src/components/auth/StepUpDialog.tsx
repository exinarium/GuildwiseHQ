import { useEffect, useRef, useState } from 'react';
import { ApiError, post, setStepUpHandler } from '../../api/client.ts';
import { Button, Dialog, TextInput } from '../ui.tsx';
import { PasswordInput } from './PasswordInput.tsx';

type Method = 'totp' | 'password';

/**
 * "Confirm it's you" (R5). Asks for a fresh code from the authenticator app (or a recovery code), or the password for
 * accounts without two-factor login, and posts it to `/api/auth/step-up`. Resolves true when the proof was accepted, so
 * the API client sends the guarded request once more; false when the person cancels.
 */
export function StepUpDialog({
  open,
  method,
  onDone,
}: {
  open: boolean;
  method: Method;
  onDone: (ok: boolean) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue('');
      setError(undefined);
    }
  }, [open]);

  const submit = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await post('/auth/step-up', method === 'totp' ? { code: value.trim() } : { password: value });
      onDone(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'session_ended') {
        onDone(false);
        window.location.assign('/login');
        return;
      }
      const left =
        e instanceof ApiError
          ? (e.details as { attemptsLeft?: number } | undefined)?.attemptsLeft
          : undefined;
      const base =
        e instanceof ApiError && (e.code === 'invalid_code' || e.code === 'wrong_password')
          ? method === 'totp'
            ? 'That code is not right.'
            : 'That password is not right.'
          : e instanceof Error
            ? e.message
            : 'Something went wrong';
      setError(left !== undefined ? `${base} ${left} ${left === 1 ? 'try' : 'tries'} left.` : base);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onDone(false);
      }}
      title="Confirm it's you"
      description={
        method === 'totp'
          ? 'Enter the 6-digit code from your authenticator app (or a recovery code) to continue.'
          : 'Enter your password to continue.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !value.trim()} data-testid="step-up-submit">
            Confirm
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {method === 'totp' ? (
          <TextInput
            label="Code"
            autoComplete="one-time-code"
            inputMode="text"
            autoFocus
            value={value}
            error={error}
            onChange={(e) => setValue(e.target.value)}
            data-testid="step-up-code"
          />
        ) : (
          <PasswordInput
            label="Password"
            autoComplete="current-password"
            autoFocus
            value={value}
            error={error}
            onChange={(e) => setValue(e.target.value)}
            data-testid="step-up-password"
          />
        )}
      </form>
    </Dialog>
  );
}

/**
 * Mounted once at the root: registers the API client's step-up handler and shows the dialog when a guarded request asks.
 * Requests that ask while the dialog is open wait for the same answer.
 */
export function StepUpHost() {
  const [method, setMethod] = useState<Method | null>(null);
  const waiting = useRef<Array<(ok: boolean) => void>>([]);
  useEffect(
    () =>
      setStepUpHandler(
        (m) =>
          new Promise<boolean>((resolve) => {
            waiting.current.push(resolve);
            setMethod((cur) => cur ?? m);
          }),
      ),
    [],
  );
  const done = (ok: boolean) => {
    const list = waiting.current;
    waiting.current = [];
    setMethod(null);
    for (const r of list) r(ok);
  };
  return <StepUpDialog open={method !== null} method={method ?? 'totp'} onDone={done} />;
}
