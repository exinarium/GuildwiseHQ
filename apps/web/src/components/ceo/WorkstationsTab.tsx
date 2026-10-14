import type { CeoStatusDto } from '@aom/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client.ts';
import { useMoveCeo } from '../../api/queries/ceo.ts';
import { Badge, Button, Callout, ErrorBox, Panel } from '../ui.tsx';

/** Where the CEO runs. It has one home workstation; moving it is deliberate, and there is no automatic failover. */
export function WorkstationsTab({ status, owner }: { status: CeoStatusDto; owner: boolean }) {
  const move = useMoveCeo();
  const [ack, setAck] = useState(false);
  const home = status.workstations.find((w) => w.current);
  const needsAck = move.error instanceof ApiError && move.error.code === 'unsandboxed_ack_required';
  return (
    <div className="flex flex-col gap-4" data-testid="ceo-workstations">
      <Panel title="Home workstation">
        <p className="text-base text-fg" data-testid="ceo-home">
          {home ? home.name : (status.agent?.workstationName ?? 'None')}
          {home && (
            <Badge className="ml-2" tone={home.online ? 'green' : 'red'}>
              {home.online ? 'Online' : 'Offline'}
            </Badge>
          )}
        </p>
        <p className="mt-1 text-sm text-muted">
          The CEO works on this workstation only. If it goes offline the CEO waits; it does not move by
          itself. Move it here when you want it elsewhere.
        </p>
      </Panel>
      <Panel title="Your workstations" padding="none">
        <ul className="divide-y divide-line">
          {status.workstations.map((w) => (
            <li
              key={w.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              data-testid="ceo-workstation"
            >
              <div className="min-w-0">
                <p className="text-base font-medium text-fg">
                  {w.name}
                  {w.current && (
                    <Badge className="ml-2" tone="brand">
                      Home
                    </Badge>
                  )}
                </p>
                <p className="text-sm text-muted">
                  {w.online ? 'Online' : 'Offline'}
                  {!w.capable && ' · the runner is too old: update it'}
                </p>
              </div>
              {owner && !w.current && (
                <Button
                  disabled={!w.capable}
                  loading={move.isPending && move.variables?.workstationId === w.id}
                  aria-label={`Move the CEO to ${w.name}`}
                  onClick={() =>
                    move.mutate({ workstationId: w.id, ...(ack ? { acknowledgeUnsandboxed: true } : {}) })
                  }
                >
                  Move the CEO here
                </Button>
              )}
            </li>
          ))}
          {status.workstations.length === 0 && (
            <li className="px-4 py-3 text-sm text-muted">You have no workstations yet.</li>
          )}
        </ul>
      </Panel>
      {needsAck && (
        <Callout tone="warning" role="alert">
          <p>{(move.error as ApiError).message}</p>
          <label className="mt-2 flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              className="size-4"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            I accept the risk. Then press Move again.
          </label>
        </Callout>
      )}
      {!needsAck && <ErrorBox error={move.error} />}
    </div>
  );
}
