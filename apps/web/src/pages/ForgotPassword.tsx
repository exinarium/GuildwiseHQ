import { PasswordResetRequestSchema } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useRequestPasswordReset } from '../api/queries/auth.ts';
import { AuthFrame } from '../components/auth/AuthFrame.tsx';
import { Button, Callout, TextInput } from '../components/ui.tsx';
import { usePageTitle } from '../lib/usePageTitle.ts';

/** `/forgot-password`: ask for a reset link. The answer is the same whether or not the email has an account. */
export function ForgotPassword() {
  usePageTitle('Forgot password');
  const request = useRequestPasswordReset();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = PasswordResetRequestSchema.safeParse({ email: email.trim() });
    if (!parsed.success) {
      setError('Enter a valid email address');
      return;
    }
    setError(undefined);
    request.mutate(parsed.data.email);
  };

  if (request.isSuccess)
    return (
      <AuthFrame>
        <div className="mb-6">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">Check your email</h1>
          <p className="mt-1.5 text-base text-muted">
            If an account exists for <strong>{email.trim()}</strong>, we have sent a link to choose a new
            password. It works once and expires in an hour.
          </p>
        </div>
        <p className="text-sm text-subtle">
          Nothing arrived? Check your spam folder, or wait a few minutes and ask again.
        </p>
        <Link
          to="/login"
          className="mt-6 inline-block text-sm text-brand-text underline-offset-2 hover:underline"
        >
          Back to sign in
        </Link>
      </AuthFrame>
    );

  return (
    <AuthFrame>
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Forgot your password?</h1>
        <p className="mt-1.5 text-base text-muted">
          Enter your email and we will send you a link to choose a new one.
        </p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Forgot password">
        <TextInput
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error}
        />
        {request.isError && (
          <Callout tone="danger" role="alert">
            {request.error instanceof ApiError && request.error.status === 429
              ? 'Too many requests. Wait a while and try again.'
              : 'Cannot reach the server. Check your connection and try again.'}
          </Callout>
        )}
        <Button type="submit" variant="primary" size="lg" loading={request.isPending} className="w-full">
          Send the link
        </Button>
      </form>
      <Link
        to="/login"
        className="mt-6 inline-block text-sm text-brand-text underline-offset-2 hover:underline"
      >
        Back to sign in
      </Link>
    </AuthFrame>
  );
}
