import { useState } from 'react';
import { usePatchPlatformUser, usePlatformUsers, useResetUserTwoFactor } from '../../api/queries/platform.ts';
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

/** `/platform/users`: every account, deactivate or reactivate it, reset its two-factor login. */
export function PlatformUsers() {
  const [q, setQ] = useState('');
  const users = usePlatformUsers(q);
  const patch = usePatchPlatformUser();
  const reset = useResetUserTwoFactor();
  const toast = useToast();
  const [resetting, setResetting] = useState<{ id: string; name: string } | null>(null);
  return (
    <div>
      <PageHeader
        title="Accounts"
        sub="Everyone with an account. An Owner is deactivated only after ownership moves."
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
                  </span>
                </span>
                {u.kind === 'user' && (
                  <span className="flex gap-1">
                    {u.twoFactorEnabled && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setResetting({ id: u.id, name: u.displayName })}
                      >
                        Reset 2FA
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
        open={!!resetting}
        onOpenChange={(o) => !o && setResetting(null)}
        title={`Reset two-factor login for ${resetting?.name ?? ''}?`}
        description="They sign in with their password only until they set it up again. The reset is recorded in the audit log."
        confirmLabel="Reset"
        onConfirm={() => {
          if (resetting)
            reset.mutate(resetting.id, { onSuccess: () => toast.success('Two-factor login reset') });
          setResetting(null);
        }}
      />
    </div>
  );
}
