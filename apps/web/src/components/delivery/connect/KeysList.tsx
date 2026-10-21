import { type DeployKeyDto, revokeErrorText } from '@aom/shared';
import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useOp, useRevokeKey } from '../../../api/queries/deploy-connect.ts';
import { agoText } from '../../../lib/ago.ts';
import { Badge, Button, ConfirmDialog, ErrorBox, Spinner } from '../../ui.tsx';

/**
 * The Guildwise keys on a server (design J5): one per computer that connected, public parts only. A key of another computer can
 * be removed from the server - exactly that one line, shown by its fingerprint, after a confirmation. Keys that people put
 * there themselves are not listed and never offered for removal.
 */
export function KeysList({
  projectId,
  targetId,
  keys,
  signInWorkstationId,
  onChanged,
}: {
  projectId: string;
  targetId: string;
  keys: readonly DeployKeyDto[];
  /** The computer that signs in to remove a key (this one has its own working key). */
  signInWorkstationId: string | null;
  onChanged?: () => void;
}) {
  const [asking, setAsking] = useState<DeployKeyDto | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const revoke = useRevokeKey(projectId);
  const op = useOp(projectId, running);
  useEffect(() => {
    if (op.data && op.data.state !== 'pending') onChanged?.();
  }, [op.data, onChanged]);
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="keys-list">
      <ul className="flex flex-col gap-2">
        {keys.map((k) => (
          <li
            key={k.fingerprint}
            className="flex flex-wrap items-center gap-2 rounded-control border border-line p-2 text-sm"
            data-testid={`key-${k.fingerprint.slice(7, 15)}`}
          >
            <KeyRound aria-hidden="true" className="size-4 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-fg">{k.workstationName}</span>
              <span className="block text-xs text-subtle [overflow-wrap:anywhere]">
                {k.fingerprint}, added {agoText(k.addedAt)}
              </span>
            </span>
            {k.state === 'revoked' ? (
              <Badge>Removed from the server</Badge>
            ) : (
              <>
                <Badge tone="green">Allowed</Badge>
                {signInWorkstationId && k.workstationId !== signInWorkstationId && (
                  <Button size="sm" onClick={() => setAsking(k)} data-testid="key-remove">
                    Remove
                  </Button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {running && op.data?.state === 'pending' && (
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner inline label="Removing" />
          Removing the key from the server...
        </div>
      )}
      {op.data && op.data.state !== 'pending' && (
        <p
          className={op.data.ok ? 'text-sm text-success' : 'text-sm text-danger'}
          role="status"
          data-testid="key-remove-result"
        >
          {op.data.ok
            ? 'The key was removed from the server.'
            : (op.data.errorText ?? revokeErrorText('failed'))}
        </p>
      )}
      <ErrorBox error={revoke.error} />
      <ConfirmDialog
        open={!!asking}
        onOpenChange={(o) => !o && setAsking(null)}
        title={`Remove the key of ${asking?.workstationName ?? ''}?`}
        description="That computer can no longer sign in to the server with Guildwise."
        confirmLabel="Remove the key"
        pending={revoke.isPending}
        onConfirm={() => {
          if (!asking || !signInWorkstationId) return;
          revoke.mutate(
            { targetId, workstationId: signInWorkstationId, fingerprint: asking.fingerprint },
            {
              onSuccess: (r) => {
                setRunning(r.commandId);
                setAsking(null);
              },
            },
          );
        }}
      >
        <p className="text-sm text-muted">
          Guildwise removes exactly one line from the server's list of allowed keys, the one with this
          fingerprint (it made that line itself). A dated copy of the list is saved first. Keys you or your
          host added are never touched.
        </p>
        <p className="mt-2 font-mono text-xs [overflow-wrap:anywhere]" data-testid="key-remove-fingerprint">
          {asking?.fingerprint}
        </p>
      </ConfirmDialog>
    </div>
  );
}
