import { useState } from 'react';
import { usePatchPlatformUser, usePlatformUsers, useSendPasswordReset } from '../../api/queries/platform.ts';
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorBox,
  ListSkeleton,
  PageHeader,
  Panel,
  TextInput,
  useToast,
} from '../../components/ui.tsx';
import { formatDateTime } from '../../lib/time.ts';

/**
 * `/platform/users`: every account, deactivate or reactivate it, mail it a password reset link. There is no two-factor
 * reset here (R17-2): a user who lost the authenticator recovers it by email from the sign-in page.
 */
export function PlatformUsers() {
  const [q, setQ] = useState('');
  const users = usePlatformUsers(q);
  const patch = usePatchPlatformUser();
  const sendReset = useSendPasswordReset();
  const toast = useToast();
  const [mailing, setMailing] = useState<{ id: string; name: string; email: string } | null>(null);
  return (
    <div>
      <PageHeader
        title="Accounts"
        sub="Everyone with an account. An Owner is deactivated only after ownership moves. Someone who lost their authenticator uses “Lost your authenticator?” when signing in."
      />
      <div className="mb-4 max-w-sm">
        <TextInput
          label="Search"
          placeholder="Name or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {users.isPending && <ListSkeleton label="Loading accounts" rows={4} />}
      {users.isError && <ErrorBox error={users.error} />}
      {patch.isError && <ErrorBox error={patch.error} />}
      {sendReset.isError && <ErrorBox error={sendReset.error} />}
      {users.data && (
        <Panel padding="none">
          <ul className="divide-y divide-line text-sm" data-testid="platform-users">
            {users.data.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{u.displayName}</span>
                    {u.kind === 'super_admin' && <Badge tone="brand">Platform admin</Badge>}
                    {u.status === 'deactivated' && <Badge tone="danger">deactivated</Badge>}
                    {u.twoFactorEnabled && <Badge tone="success">2FA on</Badge>}
                  </span>
                  <span className="block text-xs break-all text-subtle">
                    {u.email} · {u.orgCount} organization{u.orgCount === 1 ? '' : 's'}
                    {u.lastLoginAt ? ` · last sign-in ${formatDateTime(u.lastLoginAt)}` : ''}
                    {u.passwordResetSentAt
                      ? ` · reset link sent ${formatDateTime(u.passwordResetSentAt)}`
                      : ''}
                  </span>
                </span>
                {u.kind === 'super_admin' && u.status === 'active' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Send a password reset link to ${u.displayName}`}
                    onClick={() => setMailing({ id: u.id, name: u.displayName, email: u.email })}
                  >
                    Send reset link
                  </Button>
                )}
                {u.kind === 'user' && (
                  <span className="flex gap-1">
                    {u.status === 'active' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Send a password reset link to ${u.displayName}`}
                        onClick={() => setMailing({ id: u.id, name: u.displayName, email: u.email })}
                      >
                        Send reset link
                      </Button>
                    )}
                    <Button
                      variant={u.status === 'active' ? 'danger-ghost' : 'secondary'}
                      size="sm"
                      aria-label={`${u.status === 'active' ? 'Deactivate' : 'Reactivate'} ${u.displayName}`}
                      onClick={() =>
                        patch.mutate({ id: u.id, status: u.status === 'active' ? 'deactivated' : 'active' })
                      }
                    >
                      {u.status === 'active' ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <ConfirmDialog
        open={!!mailing}
        onOpenChange={(o) => !o && setMailing(null)}
        title={`Send a password reset link to ${mailing?.name ?? ''}?`}
        description={`The link goes to ${mailing?.email ?? ''}, works once and expires in an hour. Their other sessions end when they use it, and two-factor login still applies. The send is recorded in the audit log.`}
        confirmLabel="Send"
        onConfirm={() => {
          if (mailing)
            sendReset.mutate(mailing.id, {
              onSuccess: (r) => toast.success(`Reset link sent to ${r.sentTo}`),
            });
          setMailing(null);
        }}
      />
    </div>
  );
}
