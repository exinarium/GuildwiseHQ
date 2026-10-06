import { LoginRequestSchema } from '@aom/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useLogin, useMe } from '../api/queries/auth.ts';
import { AuthFrame } from '../components/auth/AuthFrame.tsx';
import { PasswordInput } from '../components/auth/PasswordInput.tsx';
import { Button, Callout, TextInput } from '../components/ui.tsx';
import { usePageTitle } from '../lib/usePageTitle.ts';

/** Only same-origin relative paths are honoured for `?next=`. */
export function safeNext(next: string | null): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function failureText(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 400)
      return 'That email and password do not match. Check them and try again.';
    if (err.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (err.status === 403) return 'This account is deactivated. Ask your admin.';
    if (err.status >= 500) return 'Cannot reach the server. Check your connection and try again.';
  }
  return 'Cannot reach the server. Check your connection and try again.';
}

export function Login() {
  usePageTitle('Sign in');
  const me = useMe();
  const login = useLogin();
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const next = safeNext(params.get('next'));
  const emailRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const failure = failureText(login.error);
  const expired = !failure && (loc.state as { expired?: boolean } | null)?.expired;

  useEffect(() => {
    if (login.isError) {
      setPassword('');
      passRef.current?.focus();
    }
  }, [login.isError]);
  useEffect(() => {
    // autofocus on pointer devices only: on touch the keyboard would cover the form
    if (window.matchMedia?.('(pointer: fine)').matches) emailRef.current?.focus();
  }, []);

  if (me.data) return <Navigate to={next} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = LoginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      const errs: typeof errors = {};
      for (const i of parsed.error.issues) {
        const k = i.path[0];
        if (k === 'email') errs.email = 'Enter a valid email address';
        if (k === 'password') errs.password = 'Enter your password';
      }
      setErrors(errs);
      (errs.email ? emailRef : passRef).current?.focus();
      return;
    }
    setErrors({});
    login.mutate(parsed.data, { onSuccess: () => nav(next, { replace: true }) });
  };

  return (
    <AuthFrame>
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Welcome back</h1>
        <p className="mt-1.5 text-base text-muted">Sign in to your guild.</p>
      </div>
      {expired && (
        <Callout tone="info" className="mb-4" role="status">
          Your session ended. Sign in to continue.
        </Callout>
      )}
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Sign in">
        <TextInput
          ref={emailRef}
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@company.com"
          readOnly={login.isPending}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <PasswordInput
          ref={passRef}
          label="Password"
          name="password"
          autoComplete="current-password"
          capsHint
          readOnly={login.isPending}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        {failure && (
          <Callout tone="danger" role="alert">
            {failure}
          </Callout>
        )}
        <Button type="submit" variant="primary" size="lg" loading={login.isPending} className="w-full">
          {login.isPending ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-6 text-sm text-subtle">
        Forgot your password? Ask your admin to send a new invitation.
      </p>
    </AuthFrame>
  );
}
