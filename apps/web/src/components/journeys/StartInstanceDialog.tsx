import type { JourneyRecordType } from '@aom/shared';
import { useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { Button, Dialog, ErrorBox, TextInput } from '../ui.tsx';

/** Starts a journey on a new record: the firm's name for the client, matter or deal, and optionally its own id. */
export function StartInstanceDialog({
  open,
  onOpenChange,
  recordType,
  busy,
  error,
  onStart,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  recordType: JourneyRecordType;
  busy?: boolean;
  error?: unknown;
  onStart: (v: { type: JourneyRecordType; displayName: string; externalId?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [ext, setExt] = useState('');
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Start on a ${recordType}`}
      description="The record keeps a name, your own id and where it is in the journey. Answers and documents stay in your own storage."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!name.trim()}
            onClick={() =>
              onStart({
                type: recordType,
                displayName: name.trim(),
                ...(ext.trim() ? { externalId: ext.trim() } : {}),
              })
            }
          >
            Start journey
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          enterKeyHint="next"
          autoComplete="off"
        />
        <TextInput
          label="Your own id (optional)"
          value={ext}
          onChange={(e) => setExt(e.target.value)}
          enterKeyHint="done"
          autoComplete="off"
          autoCapitalize="none"
        />
        {error ? <ErrorBox error={error} /> : null}
        {error ? <span className="sr-only">{errorMessage(error)}</span> : null}
      </div>
    </Dialog>
  );
}
