import { LoginRequestSchema } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { ApiError } from '../api/client.ts';
import { useLogin, useMe } from '../api/queries/auth.ts';
import { Button, TextInput } from '../components/ui.tsx';

/** Only same-origin relative paths are honoured for `?next=`. */
export function safeNext(next: string | null): string {
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function Login() {
  const me = useMe();
  const login = useLogin();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const next = safeNext(params.get('next'));

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
      return;
    }
    setErrors({});
    login.mutate(parsed.data, { onSuccess: () => nav(next, { replace: true }) });
  };

  const failure =
    login.error instanceof ApiError && (login.error.status === 401 || login.error.status === 400)
      ? 'Incorrect email or password'
      : login.error
        ? login.error.message
        : null;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-4 p-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-subtle">Agent Org Manager</p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3" aria-label="Sign in">
        <TextInput
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
        />
        <TextInput
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        {failure && (
          <p role="alert" className="text-sm font-medium text-danger">
            {failure}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={login.isPending}>
          {login.isPending ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
