import { PasswordSchema } from '@aom/shared';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useConfirmPasswordReset, useResetLinkValid } from '../api/queries/auth.ts';
import { AuthFrame } from '../components/auth/AuthFrame.tsx';
import { PasswordInput } from '../components/auth/PasswordInput.tsx';
import { Button, ButtonLink, EmptyState, Skeleton } from '../components/ui.tsx';
import { usePageTitle } from '../lib/usePageTitle.ts';

/** `/reset-password/:token`: choose a new password from the emailed link. It does not sign in: sign in again after. */
export function ResetPassword() {
  usePageTitle('Choose a new password');
  const { token = '' } = useParams();
  const link = useResetLinkValid(token);
  const confirm = useConfirmPasswordReset();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [errors, setErrors] = useState<{ password?: string; again?: string }>({});

  if (link.isPending)
    return (
      <AuthFrame>
        <div role="status" aria-live="polite" className="space-y-4">
          <span className="sr-only">Checking the link...</span>
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-11 w-full" />
        </div>
      </AuthFrame>
    );

  if (link.isError || !link.data?.valid || confirm.isError)
    return (
      <AuthFrame>
        <EmptyState
          bare
          icon={KeyRound}
          tone="warning"
          title="This link is no longer valid"
          description="It may have expired or already been used. Ask for a new one."
          action={
            <ButtonLink to="/forgot-password" variant="secondary">
              Send a new link
            </ButtonLink>
          }
        />
      </AuthFrame>
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: typeof errors = {};
    if (!PasswordSchema.safeParse(password).success) errs.password = 'Use at least 12 characters';
    if (again !== password) errs.again = 'The two passwords do not match';
    setErrors(errs);
    if (errs.password || errs.again) return;
    confirm.mutate(
      { token, password },
      { onSuccess: () => nav('/login', { replace: true, state: { passwordReset: true } }) },
    );
  };

  return (
    <AuthFrame>
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">Choose a new password</h1>
        <p className="mt-1.5 text-base text-muted">
          You will be signed out everywhere else, then sign in again with the new password.
        </p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Reset password">
        <PasswordInput
          label="New password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
        />
        <PasswordInput
          label="Repeat the password"
          name="repeat-password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          error={errors.again}
        />
        <Button type="submit" variant="primary" size="lg" loading={confirm.isPending} className="w-full">
          Save the password
        </Button>
      </form>
    </AuthFrame>
  );
}
