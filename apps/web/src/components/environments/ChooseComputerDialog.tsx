import type { SetupStateDto } from '@aom/shared';
import { useState } from 'react';
import { usePatchDeployTarget } from '../../api/queries/phases.ts';
import { Badge, Button, Callout, Dialog, ErrorBox, useToast } from '../ui.tsx';
import { Choice } from './Choice.tsx';
import type { PlaceVm } from './model.ts';

/**
 * The computer that deployed a place was removed (unpaired): the Owner picks another of their computers for it. Every active
 * computer of the project's members that is theirs is offered, whether or not it is a place yet; the place (and so every
 * environment that uses it) keeps its name and moves to the chosen computer. A server is reconnected instead (the new computer
 * has to sign in to it): see `ConnectServer`.
 */
export function ChooseComputerDialog({
  projectId,
  s,
  place,
  onClose,
}: {
  projectId: string;
  s: SetupStateDto;
  place: PlaceVm;
  onClose: () => void;
}) {
  const options = s.workstations.filter((w) => w.mine);
  const [pick, setPick] = useState('');
  const patch = usePatchDeployTarget(projectId);
  const toast = useToast();
  const chosen = options.find((w) => w.id === pick);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Choose a computer for ${place.key}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!chosen}
            loading={patch.isPending}
            data-testid="choose-computer-confirm"
            onClick={() =>
              chosen &&
              patch.mutate(
                { id: place.id, body: { workstationId: chosen.id } },
                {
                  onSuccess: () => {
                    toast.success(`${place.key} now runs on ${chosen.name}. Check it and try it again.`);
                    onClose();
                  },
                },
              )
            }
          >
            Use {chosen?.name ?? 'this computer'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="choose-computer-dialog">
        <Callout tone="warning">
          The computer that ran {place.key} was removed. Everything that used it keeps its name and settings;
          it only needs a computer that runs Docker for it.
        </Callout>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium text-fg">Run {place.key} on</legend>
          {options.map((w) => (
            <Choice
              key={w.id}
              name="choose-computer"
              checked={pick === w.id}
              onSelect={() => setPick(w.id)}
              title={w.name}
              testId={`choose-computer-${w.name}`}
            >
              <Badge tone={w.connected ? 'green' : 'neutral'}>{w.connected ? 'Online' : 'Offline'}</Badge>
            </Choice>
          ))}
          {options.length === 0 && (
            <p className="text-sm text-muted" data-testid="choose-computer-none">
              You have no other computer paired. Pair one on the Computers page, then come back.{' '}
              <a href="/workstations" className="text-brand underline-offset-2 hover:underline">
                Open Computers
              </a>
            </p>
          )}
        </fieldset>
        <ErrorBox error={patch.error} />
      </div>
    </Dialog>
  );
}
