import { Check, Copy, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  useDisableTwoFactor,
  useEnableTwoFactor,
  useRegenerateRecoveryCodes,
  useTwoFactorSetup,
  useTwoFactorStatus,
} from '../../api/queries/auth.ts';
import { PasswordInput } from '../auth/PasswordInput.tsx';
import { Badge, Button, Callout, Dialog, ErrorBox, Panel, TextInput, useToast } from '../ui.tsx';
import { QrCode } from './QrCode.tsx';

/** The one-time recovery codes: copy or save them; they are not shown again. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      /* the codes stay on screen */
    }
  };
  return (
    <div className="space-y-4" data-testid="recovery-codes">
      <Callout tone="warning" role="status" title="Save these recovery codes now">
        Each works once if you lose your phone. They are not shown again.
      </Callout>
      <ul className="grid grid-cols-2 gap-2 rounded-control border border-line bg-sunken p-3 font-mono text-sm text-fg">
        {codes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={copy} aria-label="Copy the recovery codes">
          {copied ? (
            <Check aria-hidden="true" className="size-4" />
          ) : (
            <Copy aria-hidden="true" className="size-4" />
          )}
          {copied ? 'Copied' : 'Copy codes'}
        </Button>
      </div>
      <label className="flex items-center gap-2.5 text-sm text-fg">
        <input
          type="checkbox"
          className="size-4"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        I saved my recovery codes somewhere safe
      </label>
      <div className="flex justify-end">
        <Button variant="primary" disabled={!saved} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

type Step = 'password' | 'scan' | 'codes';

/** Set up two-factor login: password, QR code and a first code, then the recovery codes. */
export function TwoFactorSetup({ onFinished }: { onFinished?: () => void }) {
  const setup = useTwoFactorSetup();
  const enable = useEnableTwoFactor();
  const [step, setStep] = useState<Step>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);

  const begin = (e: FormEvent) => {
    e.preventDefault();
    setup.mutate(password, { onSuccess: () => setStep('scan') });
  };
  const confirm = (e: FormEvent) => {
    e.preventDefault();
    enable.mutate(code, {
      onSuccess: (r) => {
        setCodes(r.recoveryCodes);
        setStep('codes');
      },
    });
  };

  if (step === 'password')
    return (
      <form onSubmit={begin} className="space-y-4" aria-label="Start two-factor setup" noValidate>
        <p className="text-sm text-muted">
          You will need an authenticator app (1Password, Authy, Google Authenticator, or similar). Confirm
          your password to begin.
        </p>
        <PasswordInput
          label="Your password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorBox error={setup.error} />
        <Button type="submit" variant="primary" loading={setup.isPending} disabled={!password}>
          Continue
        </Button>
      </form>
    );

  if (step === 'scan' && setup.data)
    return (
      <form onSubmit={confirm} className="space-y-4" aria-label="Confirm the code" noValidate>
        <div className="flex flex-wrap items-start gap-5">
          <QrCode value={setup.data.otpauthUri} label="QR code for your authenticator app" />
          <div className="min-w-0 flex-1 space-y-2 text-sm text-muted">
            <p>
              <strong className="text-fg">1.</strong> Scan the code with your authenticator app.
            </p>
            <p>
              No camera? Enter this key by hand:
              <code className="mt-1 block rounded-control bg-sunken px-2 py-1.5 font-mono text-sm break-all text-fg select-all">
                {setup.data.secret}
              </code>
            </p>
            <p>
              <strong className="text-fg">2.</strong> Type the 6-digit code it shows.
            </p>
          </div>
        </div>
        <TextInput
          label="6-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="[0-9]*"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          data-testid="totp-code"
        />
        <ErrorBox error={enable.error} />
        <Button type="submit" variant="primary" loading={enable.isPending} disabled={code.length !== 6}>
          Turn on two-factor login
        </Button>
      </form>
    );

  return <RecoveryCodes codes={codes} onDone={() => onFinished?.()} />;
}

/** "Two-factor login" on the account page: status, set up, new recovery codes, turn off (unless required). */
export function TwoFactorPanel() {
  const status = useTwoFactorStatus();
  const disable = useDisableTwoFactor();
  const regenerate = useRegenerateRecoveryCodes();
  const toast = useToast();
  const [setting, setSetting] = useState(false);
  const [confirming, setConfirming] = useState<'disable' | 'codes' | null>(null);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [fresh, setFresh] = useState<string[] | null>(null);
  const s = status.data;

  const close = () => {
    setConfirming(null);
    setPassword('');
    setCode('');
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (confirming === 'disable')
      disable.mutate(
        { password, code },
        {
          onSuccess: () => {
            toast.success('Two-factor login is off');
            close();
          },
        },
      );
    else
      regenerate.mutate(
        { password, code },
        {
          onSuccess: (r) => {
            setFresh(r.recoveryCodes);
            close();
          },
        },
      );
  };

  return (
    <Panel data-testid="two-factor-panel">
      <div className="flex flex-wrap items-start gap-4">
        <span
          className={`flex size-12 shrink-0 items-center justify-center rounded-full ${s?.enabled ? 'bg-success-soft text-success-soft-fg' : 'bg-neutral-soft text-neutral-soft-fg'}`}
        >
          {s?.enabled ? (
            <ShieldCheck aria-hidden="true" className="size-6" />
          ) : (
            <ShieldOff aria-hidden="true" className="size-6" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-fg">
            Two-factor login
            {s && <Badge tone={s.enabled ? 'green' : 'neutral'}>{s.enabled ? 'On' : 'Off'}</Badge>}
            {s?.required && <Badge tone="amber">Required</Badge>}
          </h2>
          <p className="mt-1 text-sm text-muted">
            Sign-in asks for a 6-digit code from your authenticator app after the password.
            {s?.requiredBy && s.requiredBy.length > 0
              ? ` ${s.requiredBy.map((o) => o.name).join(', ')} requires it of every member.`
              : ''}
          </p>
          {s?.enabled && (
            <p className="mt-1 text-sm text-muted" data-testid="codes-left">
              {s.recoveryCodesLeft} recovery code{s.recoveryCodesLeft === 1 ? '' : 's'} left.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {s && !s.enabled && (
            <Button variant="primary" onClick={() => setSetting(true)} data-testid="set-up-2fa">
              <KeyRound aria-hidden="true" className="size-4" />
              Set up
            </Button>
          )}
          {s?.enabled && (
            <>
              <Button onClick={() => setConfirming('codes')}>New recovery codes</Button>
              <Button
                variant="danger-ghost"
                disabled={s.required}
                title={s.required ? 'Required: it cannot be turned off' : undefined}
                onClick={() => setConfirming('disable')}
              >
                Turn off
              </Button>
            </>
          )}
        </div>
      </div>

      <Dialog
        open={setting}
        onOpenChange={setSetting}
        title="Set up two-factor login"
        description="Protect your account with an authenticator app."
        size="lg"
      >
        <TwoFactorSetup onFinished={() => setSetting(false)} />
      </Dialog>

      <Dialog
        open={confirming !== null}
        onOpenChange={(o) => !o && close()}
        title={confirming === 'disable' ? 'Turn off two-factor login?' : 'Make new recovery codes?'}
        description={
          confirming === 'disable'
            ? 'Sign-in goes back to the password alone.'
            : 'The old recovery codes stop working.'
        }
      >
        <form onSubmit={submit} className="space-y-4" noValidate aria-label="Confirm">
          <PasswordInput
            label="Your password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <TextInput
            label="Code from your app"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
          />
          <ErrorBox error={disable.error ?? regenerate.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={confirming === 'disable' ? 'danger' : 'primary'}
              loading={disable.isPending || regenerate.isPending}
              disabled={!password || code.length < 6}
            >
              {confirming === 'disable' ? 'Turn off' : 'Make new codes'}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={!!fresh}
        onOpenChange={(o) => !o && setFresh(null)}
        title="Your new recovery codes"
        dismissible={false}
      >
        {fresh && <RecoveryCodes codes={fresh} onDone={() => setFresh(null)} />}
      </Dialog>
    </Panel>
  );
}
