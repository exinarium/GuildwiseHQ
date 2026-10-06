import { AcceptInvitationRequestSchema } from '@aom/shared';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  useAcceptExistingInvitation,
  useAcceptInvitation,
  useInvitation,
  useLogout,
  useMe,
} from '../api/queries/auth.ts';
import { BRAND } from '../brand.ts';
import { AuthFrame } from '../components/auth/AuthFrame.tsx';
import { PasswordInput } from '../components/auth/PasswordInput.tsx';
import { Button, ButtonLink, Callout, EmptyState, ErrorBox, Skeleton, TextInput } from '../components/ui.tsx';
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

const ROLE_PHRASE = { owner: 'its Owner', admin: 'an Admin', member: 'a Member' } as const;

function InvalidInvitation() {
  return (
    <AuthFrame>
      <EmptyState
        bare
        icon={KeyRound}
        tone="warning"
        title="This invitation is no longer valid"
        description="It may have expired, been revoked or already been used. Ask whoever invited you for a new one."
        action={
          <ButtonLink to="/login" variant="secondary">
            Go to sign in
          </ButtonLink>
        }
      />
    </AuthFrame>
  );
}

/**
 * `/invite/:token` (docs/design/organizations.md section 11.4): start an organization (super admin invitation), join
 * one (member invitation) or the legacy account invitation. New accounts choose a name and password; an existing account
 * signs in and confirms; a different signed-in account is asked to sign out first.
 */
export function AcceptInvite() {
  const { token = '' } = useParams();
  const info = useInvitation(token);
  const me = useMe();
  const accept = useAcceptInvitation(token);
  const acceptExisting = useAcceptExistingInvitation(token);
  const logout = useLogout();
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  usePageTitle(info.isError ? 'Invitation unavailable' : 'Accept your invitation');

  if (info.isPending || me.isPending)
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
  if (info.isError || !info.data) return <InvalidInvitation />;
  const inv = info.data;
  const startsOrg = inv.kind !== 'org_member';
  const name = startsOrg ? orgName || inv.proposedOrgName || '' : (inv.orgName ?? '');
  const signedIn = me.data ?? null;
  const sameAccount = !!signedIn && signedIn.user.email.toLowerCase() === inv.email.toLowerCase();
  const heading = startsOrg ? 'Start your organization' : `Join ${inv.orgName}`;
  const sub = startsOrg
    ? `${inv.invitedBy ?? BRAND.name} set up ${inv.proposedOrgName ?? 'an organization'} for you.`
    : `${inv.invitedBy ?? 'Someone'} invited you as ${ROLE_PHRASE[inv.role ?? 'member']}.`;

  const orgField = startsOrg && (
    <TextInput
      id="invite-orgName"
      label="Organization name"
      value={orgName || inv.proposedOrgName || ''}
      onChange={(e) => setOrgName(e.target.value)}
      maxLength={120}
      hint={inv.terms ?? undefined}
    />
  );

  // 1) A different account is signed in.
  if (signedIn && !sameAccount)
    return (
      <AuthFrame>
        <div className="mb-6">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">{heading}</h1>
          <p className="mt-1.5 text-base text-muted">{sub}</p>
        </div>
        <Callout tone="warning" role="status" title="This invitation is for another account">
          It was sent to <strong>{inv.email}</strong>, but you are signed in as{' '}
          <strong>{signedIn.user.email}</strong>.
        </Callout>
        <Button className="mt-5" variant="primary" loading={logout.isPending} onClick={() => logout.mutate()}>
          Sign out and continue
        </Button>
      </AuthFrame>
    );

  // 2) The invited account is signed in: confirm.
  if (signedIn && sameAccount)
    return (
      <AuthFrame>
        <div className="mb-6">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">{heading}</h1>
          <p className="mt-1.5 text-base text-muted">{sub}</p>
        </div>
        <div className="flex flex-col gap-4">
          {orgField}
          <ErrorBox error={acceptExisting.error} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="lg"
              loading={acceptExisting.isPending}
              onClick={() =>
                acceptExisting.mutate(startsOrg ? { orgName: name.trim() } : {}, {
                  onSuccess: () => nav('/', { replace: true }),
                })
              }
            >
              {startsOrg ? `Create ${name || 'organization'}` : `Join ${inv.orgName}`}
            </Button>
            <ButtonLink to="/" variant="ghost" size="lg">
              Not now
            </ButtonLink>
          </div>
        </div>
      </AuthFrame>
    );

  // 3) The account exists but nobody is signed in: sign in to accept.
  if (inv.accountExists)
    return (
      <AuthFrame>
        <div className="mb-6">
          <h1 className="text-3xl font-semibold tracking-tight text-fg">{heading}</h1>
          <p className="mt-1.5 text-base text-muted">{sub}</p>
        </div>
        <Callout tone="info" role="status">
          <strong>{inv.email}</strong> already has an account. Sign in to accept.
        </Callout>
        <ButtonLink
          to={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
          variant="primary"
          size="lg"
          className="mt-5 w-full"
        >
          Sign in to accept
        </ButtonLink>
      </AuthFrame>
    );

  // 4) A new account.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const parsed = AcceptInvitationRequestSchema.safeParse({
      displayName: displayName.trim(),
      password,
      ...(startsOrg && name.trim() ? { orgName: name.trim() } : {}),
    });
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        if (i.path[0] === 'displayName') errs.displayName = 'Enter your name';
        if (i.path[0] === 'password') errs.password = 'Password must be 12 to 256 characters';
        if (i.path[0] === 'orgName') errs.orgName = 'Enter a name for the organization';
      }
    }
    if (password !== confirm) errs.confirm = 'Passwords do not match';
    setErrors(errs);
    if (Object.keys(errs).length || !parsed.success) {
      const first = errs.orgName
        ? 'orgName'
        : errs.displayName
          ? 'displayName'
          : errs.password
            ? 'password'
            : 'confirm';
      document.getElementById(`invite-${first}`)?.focus();
      return;
    }
    accept.mutate(parsed.data, { onSuccess: () => nav('/', { replace: true }) });
  };

  return (
    <AuthFrame>
      <div className="mb-7">
        <h1 className="text-3xl font-semibold tracking-tight text-fg">
          {inv.kind === 'legacy' ? 'You are invited' : heading}
        </h1>
        <p className="mt-1.5 text-base text-muted">
          {inv.kind === 'legacy' ? (
            <>
              Create your {BRAND.name} account for{' '}
              <strong className="font-semibold text-fg">{inv.email}</strong>
            </>
          ) : (
            <>
              {sub} Create your account for <strong className="font-semibold text-fg">{inv.email}</strong>.
            </>
          )}
        </p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4" aria-label="Accept invitation">
        {/* the username for password managers; not a form field of its own */}
        <input
          type="text"
          autoComplete="username"
          value={inv.email}
          readOnly
          hidden
          aria-hidden="true"
          tabIndex={-1}
        />
        {startsOrg && (
          <TextInput
            id="invite-orgName"
            label="Organization name"
            value={orgName || inv.proposedOrgName || ''}
            onChange={(e) => setOrgName(e.target.value)}
            maxLength={120}
            error={errors.orgName}
            hint={inv.terms ?? undefined}
          />
        )}
        <TextInput
          id="invite-displayName"
          label="Your name"
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
          {startsOrg
            ? 'Create organization'
            : inv.kind === 'legacy'
              ? 'Create account'
              : `Join ${inv.orgName}`}
        </Button>
      </form>
    </AuthFrame>
  );
}
