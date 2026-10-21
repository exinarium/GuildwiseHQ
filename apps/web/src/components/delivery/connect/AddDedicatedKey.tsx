import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import { useConnect, useOp } from '../../../api/queries/deploy-connect.ts';
import { Button, Callout, ErrorBox, Spinner } from '../../ui.tsx';

/**
 * "Also add a dedicated Guildwise key (recommended)" for a server this computer already signs in to (design 8, requirement 8):
 * optional, never forced. The computer uses its existing sign-in once to append a new key of its own to the server's list of
 * allowed keys. It never edits the person's ssh files or removes a key. Shown with the exact change before it is made.
 */
export function AddDedicatedKey({
  projectId,
  workstationId,
  workstationName,
  alias,
  targetId,
  newTargetName,
  production = false,
  onAdded,
}: {
  projectId: string;
  workstationId: string;
  workstationName: string;
  /** The ssh name the computer already signs in with. */
  alias: string;
  /** The server target, when it exists; otherwise one is made with `newTargetName`. */
  targetId?: string | undefined;
  newTargetName?: string | undefined;
  production?: boolean;
  onAdded?: (r: { targetId: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [opId, setOpId] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const connect = useConnect(projectId);
  const op = useOp(projectId, opId);
  const finished = op.data && op.data.state !== 'pending' ? op.data : null;
  if (finished?.ok)
    return (
      <p className="text-sm text-success" role="status" data-testid="dedicated-key-done">
        {workstationName} now also has a Guildwise key for {alias}. The sign-in it already had is unchanged.
      </p>
    );
  if (!open)
    return (
      <div data-testid="dedicated-key-offer">
        <Button
          size="sm"
          className="h-auto min-h-8 whitespace-normal py-1.5 text-left"
          onClick={() => setOpen(true)}
          data-testid="dedicated-key-open"
        >
          <KeyRound aria-hidden="true" className="size-4" />
          Also add a dedicated Guildwise key (recommended)
        </Button>
        <p className="mt-1 text-xs text-subtle">
          Optional. Updates keep working with the sign-in {workstationName} already has; a key of Guildwise's
          own can be removed on its own later.
        </p>
      </div>
    );
  return (
    <Callout tone="info" title="Add a Guildwise key to the server" data-testid="dedicated-key-confirm">
      <p>
        {workstationName} signs in to <strong>{alias}</strong> the way it always did, and adds one new key of
        Guildwise's own to the server's list of allowed keys (<code>~/.ssh/authorized_keys</code>, after a
        dated copy). Your keys and your ssh settings stay exactly as they are.
      </p>
      {opId && !finished && (
        <div className="mt-2 flex items-center gap-2" role="status">
          <Spinner inline label="Adding" />
          Adding the key...
        </div>
      )}
      {finished && !finished.ok && (
        <p className="mt-2 text-danger" data-testid="dedicated-key-error">
          {finished.errorText}
        </p>
      )}
      <ErrorBox error={connect.error} />
      <div className="mt-2 flex gap-2">
        <Button size="sm" onClick={() => setOpen(false)}>
          Not now
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={connect.isPending || (!!opId && !finished)}
          onClick={() =>
            connect.mutate(
              {
                workstationId,
                method: 'alias',
                alias,
                ...((targetId ?? created)
                  ? { targetId: (targetId ?? created) as string }
                  : { newTarget: { name: newTargetName ?? alias, production } }),
              },
              {
                onSuccess: (r) => {
                  setCreated(r.targetId);
                  setOpId(r.commandId);
                  onAdded?.({ targetId: r.targetId });
                },
              },
            )
          }
          data-testid="dedicated-key-add"
        >
          Add the key
        </Button>
      </div>
    </Callout>
  );
}
