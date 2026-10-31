import { RELAY_KINDS, type RelayIntegrationDto, type RelayKind } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useCreateRelayIntegration } from '../../api/queries/relay.ts';
import { RELAY_KIND_LABEL } from '../../lib/relay.ts';
import { CopyButton } from '../delivery/connect/CopyButton.tsx';
import { Button, Dialog, ErrorBox, Select, TextInput } from '../ui.tsx';
import { RelaySetupSteps } from './RelaySetupSteps.tsx';

/** What the one-time dialog shows. It lives in component state only: never in a query cache, toast or log. */
export type RelayReveal = { integration: RelayIntegrationDto; url: string };

/**
 * Create an inbound webhook. The only two inputs on the relay surfaces are the kind and a label: there is no field
 * for a provider secret, verify token or access token.
 */
export function RelayCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (r: RelayReveal) => void;
}) {
  const create = useCreateRelayIntegration();
  const [kind, setKind] = useState<RelayKind>('whatsapp_cloud');
  const [label, setLabel] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const res = await create.mutateAsync({ kind, label: label.trim() });
    create.reset(); // the answer holds the URL: keep it out of the mutation state
    setLabel('');
    onOpenChange(false);
    onCreated({ integration: res.integration, url: res.url });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New inbound webhook"
      description="Get a private web address for one provider. Guildwise HQ passes each request to your runner."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="relay-create-form"
            loading={create.isPending}
            disabled={label.trim().length === 0}
            data-testid="relay-create-submit"
          >
            Create
          </Button>
        </>
      }
    >
      <form
        id="relay-create-form"
        onSubmit={(e) => void submit(e).catch(() => undefined)}
        className="space-y-4"
      >
        <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as RelayKind)}>
          {RELAY_KINDS.map((k) => (
            <option key={k} value={k}>
              {RELAY_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
        <TextInput
          label="Label"
          value={label}
          maxLength={80}
          autoFocus
          placeholder="Shop WhatsApp"
          onChange={(e) => setLabel(e.target.value)}
        />
        {create.error && <ErrorBox error={create.error} />}
      </form>
    </Dialog>
  );
}

/** The address of a new or rotated webhook, shown once, with the setup steps. */
export function RelayUrlDialog({ reveal, onClose }: { reveal: RelayReveal | null; onClose: () => void }) {
  return (
    <Dialog
      open={reveal !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Copy the address for ${reveal?.integration.label ?? ''}`}
      description="This address is shown once. Copy it now: it cannot be shown again. If you lose it, rotate the address to get a new one."
      size="lg"
      footer={
        <Button variant="primary" onClick={onClose} data-testid="relay-url-done">
          Done
        </Button>
      }
    >
      {reveal && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="min-w-0 select-all break-all rounded bg-sunken px-2 py-1 font-mono text-xs"
              data-testid="relay-url"
            >
              {reveal.url}
            </code>
            <CopyButton text={reveal.url} testId="relay-url-copy" />
          </div>
          <RelaySetupSteps integration={reveal.integration} addressKnown />
        </div>
      )}
    </Dialog>
  );
}
