import type { CeoStatusDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useAppointCeo } from '../../api/queries/ceo.ts';
import { Button, Callout, ErrorBox, Panel, Select, TextInput, useToast } from '../ui.tsx';

/** Appoint the CEO: one capable workstation of the Owner, and an optional name. */
export function AppointForm({
  status,
  owner,
  open,
}: {
  status: CeoStatusDto;
  owner: boolean;
  open: boolean;
}) {
  const appoint = useAppointCeo();
  const toast = useToast();
  const capable = status.workstations.filter((w) => w.capable);
  const [workstationId, setWorkstationId] = useState('');
  const [name, setName] = useState('');
  const [ack, setAck] = useState(false);
  const [shown, setShown] = useState(open);
  const chosen = workstationId || capable[0]?.id || '';
  const needsAck = appoint.error instanceof ApiError && appoint.error.code === 'unsandboxed_ack_required';

  if (!owner)
    return (
      <Callout tone="info" role="note">
        Only the Owner can appoint a CEO.
      </Callout>
    );
  if (!shown)
    return (
      <Button variant="primary" onClick={() => setShown(true)} data-testid="ceo-appoint-open">
        Appoint CEO
      </Button>
    );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    appoint.mutate(
      {
        workstationId: chosen,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(ack ? { acknowledgeUnsandboxed: true } : {}),
      },
      { onSuccess: () => toast.success('Your CEO is appointed. It starts in a training period.') },
    );
  };

  return (
    <Panel title="Appoint your CEO" data-testid="ceo-appoint">
      <form onSubmit={submit} className="flex max-w-xl flex-col gap-4" aria-label="Appoint CEO">
        {capable.length === 0 ? (
          <Callout tone="warning" role="alert">
            None of your workstations can host the CEO yet. Pair a workstation, or update its runner, then
            come back.
          </Callout>
        ) : (
          <Select
            label="Home workstation"
            value={chosen}
            onChange={(e) => setWorkstationId(e.target.value)}
            hint="The CEO works on this workstation only. There is no automatic failover."
          >
            {capable.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.online ? '' : ' (offline)'}
              </option>
            ))}
          </Select>
        )}
        <TextInput
          label="Name (optional)"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          hint="Leave empty to get a suggested name."
        />
        {needsAck && (
          <label className="flex items-start gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              className="mt-0.5 size-4"
            />
            <span>
              {(appoint.error as ApiError).message}
              <span className="block font-medium">I accept the risk.</span>
            </span>
          </label>
        )}
        {!needsAck && <ErrorBox error={appoint.error} />}
        <div>
          <Button type="submit" variant="primary" loading={appoint.isPending} disabled={!chosen}>
            Appoint CEO
          </Button>
        </div>
      </form>
    </Panel>
  );
}
