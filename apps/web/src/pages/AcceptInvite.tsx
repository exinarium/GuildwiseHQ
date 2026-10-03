import { AcceptInvitationRequestSchema } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useAcceptInvitation, useInvitation } from '../api/queries/auth.ts';
import { Button, ErrorBox, Spinner, TextInput } from '../components/ui.tsx';

export function AcceptInvite() {
  const { token = '' } = useParams();
  const info = useInvitation(token);
  const accept = useAcceptInvitation(token);
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (info.isPending) return <Spinner label="Checking invitation" />;
  if (info.isError) {
    return (
      <div className="mx-auto max-w-sm p-4">
        <h1 className="text-lg font-semibold">Invitation unavailable</h1>
        <p className="mt-2 text-sm text-zinc-500">
          This invitation link is invalid, expired, or already used. Ask your admin for a new one.
        </p>
        <Link
          to="/login"
          className="mt-3 inline-block text-sm text-indigo-600 underline dark:text-indigo-400"
        >
          Go to sign in
        </Link>
      </div>
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
    if (Object.keys(errs).length || !parsed.success) return;
    accept.mutate(parsed.data, { onSuccess: () => nav('/', { replace: true }) });
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-4 p-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Accept invitation</h1>
        <p className="text-sm text-zinc-500">
          Creating an account for <strong>{info.data.email}</strong>
        </p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label="Accept invitation">
        <TextInput
          label="Display name"
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
        />
        <TextInput
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <TextInput
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={errors.confirm}
        />
        <ErrorBox error={accept.error} />
        <Button type="submit" variant="primary" disabled={accept.isPending}>
          Create account
        </Button>
      </form>
    </div>
  );
}
