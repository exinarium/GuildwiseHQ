import { PasswordSchema } from '@aom/shared';
import { LogOut } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useChangePassword, useLogout } from '../api/queries/auth.ts';
import { AuthFrame } from '../components/auth/AuthFrame.tsx';
import { PasswordInput } from '../components/auth/PasswordInput.tsx';
import { Button, Callout, ErrorBox } from '../components/ui.tsx';
import { usePageTitle } from '../lib/usePageTitle.ts';

/**
 * Shown instead of the app after an Owner reset the account's password to a temporary one: the person must choose their
 * own password before anything else. The server refuses every other request until they have.
 */
export function ChangePasswordRequired() {
  usePageTitle('Choose a new password');
  const change = useChangePassword();
  const logout = useLogout();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<{ current?: string; password?: string; again?: string }>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!current) errs.current = 'Enter the temporary password you were given';
    if (!PasswordSchema.safeParse(password).success) errs.password = 'Use at least 12 characters';
    else if (password === current) errs.password = 'Choose a different password from the temporary one';
    if (again !== password) errs.again = 'The two passwords do not match';
    setErrors(errs);
    if (errs.current || errs.password || errs.again) return;
    change.mutate({ current, new: password });
  };

  return (
    <AuthFrame>
      <div className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Choose a new password</h1>
        <p className="mt-1.5 text-base text-muted">You signed in with a temporary password.</p>
      </div>
      <Callout tone="info" className="mb-5" role="status">
        The Owner of your organization gave you a temporary password. Choose your own now to continue.
      </Callout>
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-4"
        aria-label="Choose a new password"
        data-testid="forced-password-change"
      >
        <PasswordInput
          label="Temporary password"
          name="current-password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          error={errors.current}
        />
        <PasswordInput
          label="New password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <PasswordInput
          label="Repeat the new password"
          name="repeat-password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          error={errors.again}
        />
        <ErrorBox error={change.error} />
        <Button type="submit" variant="primary" size="lg" loading={change.isPending} className="w-full">
          Save the password
        </Button>
      </form>
      <div className="mt-8 border-t border-line pt-4">
        <Button variant="ghost" onClick={() => logout.mutate()}>
          <LogOut aria-hidden="true" className="size-4" />
          Sign out
        </Button>
      </div>
    </AuthFrame>
  );
}
