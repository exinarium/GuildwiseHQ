import { useState } from 'react';
import { useRollback, useRollbackCandidates } from '../../api/queries/releases.ts';
import { useCanManageOrg } from '../../lib/orgRole.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Button, Callout, Dialog, ErrorBox, Spinner, useToast } from '../ui.tsx';

/**
 * Going back to an earlier version (docs/design/environments-ux.md journey K): the last five successful releases, what a
 * rollback does and does not do, and where the backup of the newer release is kept. Needs the Owner or an Admin; every
 * rollback is recorded in the history.
 */
export function RollbackSheet({
  projectId,
  env,
  label,
  onClose,
}: {
  projectId: string;
  env: string;
  label: string;
  onClose: () => void;
}) {
  const q = useRollbackCandidates(projectId, env);
  const rollback = useRollback(projectId);
  const canManage = useCanManageOrg();
  const toast = useToast();
  const [commit, setCommit] = useState('');
  const list = (q.data ?? []).slice(0, 5);
  // the newest one is what runs now: it is not an earlier version
  const earlier = list.slice(1);
  const chosen = earlier.find((c) => c.commit === commit);
  const name = (c: { version: string | null; commit: string }) => c.version ?? c.commit.slice(0, 7);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Go back to an earlier version of ${label}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!chosen || !canManage}
            loading={rollback.isPending}
            data-testid="rollback-confirm"
            onClick={() =>
              chosen &&
              rollback.mutate(
                { env, commit: chosen.commit },
                {
                  onSuccess: () => {
                    toast.success(`Going back to ${name(chosen)}`);
                    onClose();
                  },
                },
              )
            }
          >
            {chosen ? `Go back to ${name(chosen)}` : 'Go back'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm" data-testid="rollback-sheet">
        <p className="text-muted">
          This puts the app back to that version. Your data is not rolled back.
          {chosen?.backupPath ? (
            <>
              {' '}
              The backup taken before the newer release is at{' '}
              <span className="font-mono text-xs [overflow-wrap:anywhere]" data-testid="rollback-backup">
                {chosen.backupPath}
              </span>{' '}
              (kept).
            </>
          ) : (
            ' The backup taken before the newer release is kept on the server.'
          )}
        </p>
        {!canManage && (
          <Callout tone="info" data-testid="rollback-owner-note">
            Only the Owner or an Admin can go back. Ask them to do it, or to approve it.
          </Callout>
        )}
        {q.isPending && <Spinner label="Loading the earlier versions" />}
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        {q.data && earlier.length === 0 && (
          <p className="text-subtle" data-testid="rollback-none">
            There is no earlier version to go back to yet.
          </p>
        )}
        {earlier.length > 0 && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="font-semibold text-fg">Choose the version</legend>
            {earlier.map((c) => (
              <label
                key={c.commit}
                className="flex min-h-11 items-center gap-3 rounded-control border border-line p-2"
                data-testid="rollback-candidate"
              >
                <input
                  type="radio"
                  name="rollback-version"
                  className="size-4"
                  checked={commit === c.commit}
                  onChange={() => setCommit(c.commit)}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-mono text-fg">{name(c)}</span>
                  <span className="block text-xs text-muted">
                    {formatDateTime(c.at)}
                    {c.releasedBy ? `, released by ${c.releasedBy}` : ''}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <ErrorBox error={rollback.error} />
      </div>
    </Dialog>
  );
}
