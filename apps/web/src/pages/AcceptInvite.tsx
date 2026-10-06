import { AcceptInvitationRequestSchema } from '@aom/shared';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useAcceptInvitation, useInvitation } from '../api/queries/auth.ts';
import { BRAND } from '../brand.ts';
import { AuthFrame } from '../components/auth/AuthFrame.tsx';
import { PasswordInput } from '../components/auth/PasswordInput.tsx';
import { Button, ButtonLink, ErrorBox, Skeleton, TextInput } from '../components/ui.tsx';
import { usePageTitle } from '../lib/usePageTitle.ts';

/** Advisory only: the single enforced rule is the schema's 12 to 256 characters. */
export function strengthOf(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (pw.length < 12) return { score: 0, label: pw.length === 0 ? '' : 'Too short' };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 20 || kinds >= 4) return { score: 3, label: 'Strong' };
  if (kinds >= 3 || pw.length >= 16) return { score: 2, label: 'Good' };
  return { score: 1, label: 'OK' };
}

function StrengthMeter({ password }: { password: string }) {
  const s = strengthOf(password);
  if (!password) return null;
  const tone = ['bg-danger-fill', 'bg-warning-fill', 'bg-success-fill', 'bg-success-fill'][s.score];
  return (
    <div className="-mt-2 flex items-center gap-3" aria-live="polite">
      <div className="flex flex-1 gap-1" aria-hidden="true">
        {['a', 'b', 'c', 'd'].map((k, i) => (
          <span
            key={k}
            className={`h-1 flex-1 rounded-full ${i <= s.score && (i > 0 || password.length >= 1) ? tone : 'bg-sunken'}`}
          />
        ))}
      </div>
      <span className="w-16 text-right text-xs text-muted">{s.label}</span>
    </div>
  );
}

export function AcceptInvite() {
  const { token = '' } = useParams();
  const info = useInvitation(token);
  const accept = useAcceptInvitation(token);
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  usePageTitle(info.isError ? 'Invitation unavailable' : 'Accept your invitation');

  if (info.isPending)
    return (
      <AuthFrame>
        <div role="status" aria-live="polite" className="space-y-4">
          <span className="sr-only">Checking invitation...</span>
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </AuthFrame>
    );
  if (info.isError) {
    return (
      <AuthFrame>
        <div className="flex flex-col items-start gap-4">
          <span className="flex size-14 items-center justify-center rounded-full bg-warning-soft text-warning-soft-fg">
            <KeyRound aria-hidden="true" className="size-7" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-fg">
            This invitation link does not work
          </h1>
          <p className="text-base text-muted">
            It may have expired or already been used. Ask your admin to send a new one.
          </p>
          <ButtonLink to="/login" variant="secondary">
            Go to sign in
          </ButtonLink>
        </div>
      </AuthFrame>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const parsed = AcceptInvitationRequestSchema.safeParse({ displayName: displayName.trim(), password });
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        if (i.path[0] === 'displayName') errs.displayName = 'Enter your name';
        if (i.path[0] === 'password') errs.password = 'Password must be 12 to 256 characters';
      }
    }
    if (password !== confirm) errs.confirm = 'Passwords do not match';
    setErrors(errs);
    if (Object.keys(errs).length || !parsed.success) {
      const first = errs.displayName ? 'displayName' : errs.password ? 'password' : 'confirm';
      document.getElementById(`invite-${first}`)?.focus();
      return;
    }
    accept.mutate(parsed.data, { onSuccess: () => nav('/', { replace: true }) });
  };

  return (
    <AuthFrame>
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">You are invited</h1>
        <p className="mt-1.5 text-base text-muted">
          Create your {BRAND.name} account for{' '}
          <strong className="font-semibold text-fg">{info.data.email}</strong>
        </p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Accept invitation">
        {/* the username for password managers; not a form field of its own */}
        <input
          type="text"
          autoComplete="username"
          value={info.data.email}
          readOnly
          hidden
          aria-hidden="true"
          tabIndex={-1}
        />
        <TextInput
          id="invite-displayName"
          label="Display name"
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
        />
        <PasswordInput
          id="invite-password"
          label="Password"
          autoComplete="new-password"
          hint="At least 12 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          capsHint
        />
        <StrengthMeter password={password} />
        <PasswordInput
          id="invite-confirm"
          label="Confirm password"
          toggleLabel=" (confirmation)"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
        />
        <ErrorBox error={accept.error} />
        <Button type="submit" variant="primary" size="lg" loading={accept.isPending} className="w-full">
          Create account
        </Button>
      </form>
    </AuthFrame>
  );
}
