import { STORAGE_KINDS, type StorageConnectionDto, type StorageKind } from '@aom/shared';
import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { useMe } from '../../api/queries/auth.ts';
import { useCreateStorageConnection } from '../../api/queries/storage.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { STORAGE_KIND_HELP, STORAGE_KIND_LABEL } from '../../lib/storage.ts';
import { Button, Callout, Dialog, Select, TextInput } from '../ui.tsx';

/** Step 1: kind, display name and the workstation that will hold the keys. Step 2 is the connect dialog. */
export function StorageAddDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (c: StorageConnectionDto) => void;
}) {
  const me = useMe();
  const workstations = useWorkstations({ enabled: open });
  const create = useCreateStorageConnection();
  const [kind, setKind] = useState<StorageKind>('onedrive');
  const [label, setLabel] = useState('');
  const [wsId, setWsId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mine = (workstations.data ?? []).filter(
    (w) => w.userId === me.data?.user.id && w.status === 'active' && w.connected,
  );

  const submit = async () => {
    setError(null);
    try {
      const r = await create.mutateAsync({ kind, label: label.trim(), workstationId: wsId || (mine[0]?.id ?? '') });
      setLabel('');
      onOpenChange(false);
      onCreated(r.connection);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add storage"
      description="Choose where form uploads and answers are stored. They go to your own storage, never to a Guildwise server."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={!label.trim() || mine.length === 0}
            onClick={() => void submit()}
            data-testid="storage-add-next"
          >
            Next
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="storage-add-dialog">
        {error && <Callout tone="danger">{error}</Callout>}
        <Select label="Type" value={kind} onChange={(e) => setKind(e.target.value as StorageKind)} hint={STORAGE_KIND_HELP[kind]}>
          {STORAGE_KINDS.map((k) => (
            <option key={k} value={k}>
              {STORAGE_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
        <TextInput label="Display name" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} />
        <Select label="Workstation" value={wsId || (mine[0]?.id ?? '')} onChange={(e) => setWsId(e.target.value)}>
          {mine.length === 0 && <option value="">No online workstation of yours</option>}
          {mine.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <p className="text-sm text-muted">The sign-in and keys stay encrypted on this workstation.</p>
      </div>
    </Dialog>
  );
}
