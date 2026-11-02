import type { StorageConnectionDto } from '@aom/shared';
import { useState } from 'react';
import { errorMessage, post } from '../../api/client.ts';
import {
  REQUEST_DONE,
  useRemoveStorageConnection,
  useRenameStorageConnection,
  useStorageConnections,
  useStorageRequest,
} from '../../api/queries/storage.ts';
import { agoText } from '../../lib/ago.ts';
import {
  STORAGE_KIND_LABEL,
  storageConnectAction,
  storageErrorText,
  storageStateLabel,
} from '../../lib/storage.ts';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  Panel,
  TextInput,
  useToast,
} from '../ui.tsx';
import { StorageAddDialog } from './StorageAddDialog.tsx';
import { StorageConnectDialog } from './StorageConnectDialog.tsx';

function TestResult({ rid }: { rid: string }) {
  const r = useStorageRequest(rid).data;
  if (!r || !REQUEST_DONE.includes(r.state)) return <span className="text-sm text-muted">Testing…</span>;
  return r.state === 'done' ? (
    <span className="text-sm text-success" data-testid="storage-test-ok">
      Test passed.
    </span>
  ) : (
    <span className="text-sm text-danger" data-testid="storage-test-failed">
      {storageErrorText(r.errorCode, r.message)}
    </span>
  );
}

/** Storage connections of the organization: list, add, test, reconnect, rename, remove. Members read; managers change. */
export function StorageTab({ canManage }: { canManage: boolean }) {
  const list = useStorageConnections();
  const rename = useRenameStorageConnection();
  const remove = useRemoveStorageConnection();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState<StorageConnectionDto | null>(null);
  const [renaming, setRenaming] = useState<StorageConnectionDto | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [removing, setRemoving] = useState<StorageConnectionDto | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});

  const runTest = async (c: StorageConnectionDto) => {
    const requestId = crypto.randomUUID();
    try {
      await post(`/org/storage/connections/${c.id}/test`, { requestId });
      setTests((t) => ({ ...t, [c.id]: requestId }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const doRename = async () => {
    if (!renaming) return;
    try {
      await rename.mutateAsync({ id: renaming.id, label: newLabel.trim() });
      setRenaming(null);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const doRemove = async () => {
    if (!removing) return;
    try {
      await remove.mutateAsync(removing.id);
      toast.success(`Removed ${removing.label}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setRemoving(null);
  };

  const rows = list.data ?? [];
  return (
    <div className="space-y-4" data-testid="storage-tab">
      <Panel
        title="Storage"
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setAdding(true)} data-testid="storage-new">
              Add storage
            </Button>
          ) : undefined
        }
      >
        <p className="mb-4 text-sm text-muted">
          Form documents and answers are written to your own storage through the runner on your workstation.
          Sign-ins and keys stay encrypted on that workstation; Guildwise keeps only a name, a type and the
          status.
        </p>
        {list.isPending ? (
          <ListSkeleton />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No storage connected yet"
            description={canManage ? 'Add one to receive form uploads.' : 'An Owner or Admin can add one.'}
          />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((c) => {
              const s = storageStateLabel(c);
              const action = storageConnectAction(c);
              return (
                <li key={c.id} className="space-y-2 py-3" data-testid={`storage-row-${c.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-fg">{c.label}</span>
                    <Badge>{STORAGE_KIND_LABEL[c.kind]}</Badge>
                    <Badge tone={s.tone} data-testid={`storage-state-${c.id}`}>
                      {s.label}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted">
                    On {c.workstation.name}
                    {c.health.checkedAt ? ` · checked ${agoText(c.health.checkedAt)}` : ''}
                    {c.health.message && c.health.state !== 'connected' ? ` · ${c.health.message}` : ''}
                  </p>
                  {tests[c.id] && <TestResult rid={tests[c.id] as string} />}
                  {canManage && (
                    <div className="flex flex-wrap gap-2">
                      {action && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => setConnecting(c)}
                          data-testid={`storage-connect-${c.id}`}
                        >
                          {action === 'connect' ? 'Connect' : 'Reconnect'}
                        </Button>
                      )}
                      {c.canConnect && (
                        <Button
                          size="sm"
                          onClick={() => void runTest(c)}
                          data-testid={`storage-test-${c.id}`}
                        >
                          Test connection
                        </Button>
                      )}
                      <Button
                        size="sm"
                        onClick={() => {
                          setRenaming(c);
                          setNewLabel(c.label);
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setRemoving(c)}
                        data-testid={`storage-remove-${c.id}`}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      {canManage && <StorageAddDialog open={adding} onOpenChange={setAdding} onCreated={setConnecting} />}
      <StorageConnectDialog
        connection={connecting}
        open={connecting !== null}
        onOpenChange={(o) => !o && setConnecting(null)}
      />
      <Dialog
        open={renaming !== null}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename storage"
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!newLabel.trim()}
              loading={rename.isPending}
              onClick={() => void doRename()}
            >
              Save
            </Button>
          </>
        }
      >
        <TextInput
          label="Display name"
          maxLength={80}
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.label ?? ''}?`}
        description={`The sign-in and keys are deleted from ${removing?.workstation.name ?? 'the workstation'}. Forms that use this connection will show a warning.`}
        confirmLabel="Remove"
        pending={remove.isPending}
        onConfirm={() => void doRemove()}
      />
    </div>
  );
}
