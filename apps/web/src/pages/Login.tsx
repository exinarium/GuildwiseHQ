import { LoginRequestSchema } from '@aom/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useLogin, useLogin2fa, useMe } from '../api/queries/auth.ts';
import { AuthFrame } from '../components/auth/AuthFrame.tsx';
import { PasswordInput } from '../components/auth/PasswordInput.tsx';
import { Button, Callout, TextInput } from '../components/ui.tsx';
import { ext } from '../extension/index.ts';
import { usePageTitle } from '../lib/usePageTitle.ts';

/** Only same-origin relative paths are honoured for `?next=`. */
export function safeNext(next: string | null): string {
  // a path on this origin only: `//host` and `/\host` are read by browsers as another site
  return next?.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

const Nothing = () => null;
const LoginErrorExtra = ext.LoginErrorExtra ?? Nothing;
const LoginFooter = ext.LoginFooter ?? Nothing;

function failureText(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 400)
      return 'That email and password do not match. Check them and try again.';
    if (err.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (err.status === 403 && (err.code === 'org_suspended' || err.code === 'email_not_verified'))
      return err.message;
    // The server answers 401 for a deactivated account (same as a wrong password), so no 403 means "deactivated".
    if (err.status === 403 && err.code === 'bad_origin')
      return "This address isn't allowed to sign in. Open the app at the address your admin gave you (its configured address) and try again.";
    if (err.status === 403) return `Sign-in was refused by the server (${err.code || 'forbidden'}).`;
    if (err.status >= 500) return 'Cannot reach the server. Check your connection and try again.';
  }
  return 'Cannot reach the server. Check your connection and try again.';
}

export function Login() {
  usePageTitle('Sign in');
  const me = useMe();
  const login = useLogin();
  const login2fa = useLogin2fa();
  const [challenge, setChallenge] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
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
  const passwordReset = !failure && (loc.state as { passwordReset?: boolean } | null)?.passwordReset;

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
    login.mutate(parsed.data, {
      onSuccess: (r) => {
        if (r.kind === 'challenge') setChallenge(r.challenge.challenge);
        else nav(next, { replace: true });
      },
    });
  };

  if (challenge)
    return (
      <AuthFrame>
        <div className="mb-7">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">Two-factor login</h1>
          <p className="mt-1.5 text-base text-muted">
            {recovery
              ? 'Enter one of your recovery codes.'
              : 'Enter the 6-digit code from your authenticator app.'}
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            login2fa.mutate(
              { challenge, code: code.trim() },
              { onSuccess: () => nav(next, { replace: true }) },
            );
          }}
          noValidate
          className="flex flex-col gap-4"
          aria-label="Two-factor code"
        >
          <TextInput
            label={recovery ? 'Recovery code' : 'Code'}
            name="code"
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            autoCapitalize="none"
            spellCheck={false}
            maxLength={recovery ? 12 : 6}
            autoFocus
            value={code}
            onChange={(e) => setCode(recovery ? e.target.value : e.target.value.replace(/\D/g, ''))}
            data-testid="login-code"
          />
          {login2fa.isError && (
            <Callout tone="danger" role="alert">
              {login2fa.error instanceof ApiError && login2fa.error.status === 429
                ? 'Too many attempts. Wait a minute and try again.'
                : 'That code is not right, or the sign-in expired. Check the code or sign in again.'}
            </Callout>
          )}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={login2fa.isPending}
            disabled={recovery ? code.trim().length < 10 : code.length !== 6}
            className="w-full"
          >
            Verify
          </Button>
        </form>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm">
          <button
            type="button"
            className="text-brand-text underline-offset-2 hover:underline"
            onClick={() => {
              setRecovery(!recovery);
              setCode('');
            }}
          >
            {recovery ? 'Use the app instead' : 'Use a recovery code'}
          </button>
          <button
            type="button"
            className="text-muted underline-offset-2 hover:underline"
            onClick={() => {
              setChallenge(null);
              setCode('');
              setRecovery(false);
            }}
          >
            Back to sign in
          </button>
        </div>
      </AuthFrame>
    );

  return (
    <AuthFrame>
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Welcome back</h1>
        <p className="mt-1.5 text-base text-muted">Sign in to your guild.</p>
      </div>
      {passwordReset && (
        <Callout tone="success" className="mb-4" role="status">
          Your password is changed. Sign in with the new one.
        </Callout>
      )}
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
            <LoginErrorExtra error={login.error} email={email} />
          </Callout>
        )}
        <Button type="submit" variant="primary" size="lg" loading={login.isPending} className="w-full">
          {login.isPending ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-6 text-sm text-subtle">
        <Link to="/forgot-password" className="text-brand-text underline-offset-2 hover:underline">
          Forgot your password?
        </Link>
      </p>
      <LoginFooter />
    </AuthFrame>
  );

  return (
    <AuthFrame>
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Welcome back</h1>
        <p className="mt-1.5 text-base text-muted">Sign in to your guild.</p>
      </div>
      {passwordReset && (
        <Callout tone="success" className="mb-4" role="status">
          Your password is changed. Sign in with the new one.
        </Callout>
      )}
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
            <LoginErrorExtra error={login.error} email={email} />
          </Callout>
        )}
        <Button type="submit" variant="primary" size="lg" loading={login.isPending} className="w-full">
          {login.isPending ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
      <p className="mt-6 text-sm text-subtle">
        <Link to="/forgot-password" className="text-brand-text underline-offset-2 hover:underline">
          Forgot your password?
        </Link>
      </p>
      <p className="mt-6 text-sm text-subtle">
        By signing in you agree to the{' '}
        <a href="/terms" className="underline underline-offset-2 hover:no-underline">
          Terms and conditions
        </a>{' '}
        and the{' '}
        <a href="/privacy" className="underline underline-offset-2 hover:no-underline">
          Privacy policy
        </a>
        .
      </p>
    </AuthFrame>
  );
}
