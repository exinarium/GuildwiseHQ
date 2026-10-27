import { useState } from 'react';
import { useHirablePacks } from '../../api/queries/my-capabilities.ts';
import { Button, Dialog, EmptyState, ErrorBox, ListSkeleton } from '../ui.tsx';
import { HirePackDialog } from './HirePackDialog.tsx';

/** From the HR board: choose one of your private packs, then the personas of it to hire. Organization packs use Hire agent > From a pack. */
export function PickPackToHire({ onClose }: { onClose: () => void }) {
  // Owners, Admins and Members alike: the approved packs with personas (a member's hire is bound to a project they are on)
  const q = useHirablePacks();
  const [pack, setPack] = useState<{ id: string; name: string } | null>(null);
  if (pack) return <HirePackDialog packId={pack.id} packName={pack.name} onClose={onClose} />;
  const trusted = (q.data?.packs ?? []).filter((p) => p.visibility === 'private');
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Hire from a private pack"
      description="Personas of your own private packs become chat-only agents with a tag that says where they came from. Packs of your organization are hired from Hire agent, From a pack."
      footer={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      {q.isPending && <ListSkeleton label="Loading packs" rows={2} />}
      {q.isError && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.data && trusted.length === 0 && (
        <EmptyState
          title="No private pack"
          description="Write one under Settings > Capabilities > My capabilities. Packs of your organization are hired from Hire agent, From a pack."
        />
      )}
      <ul className="flex flex-col gap-2" data-testid="pick-pack">
        {trusted.map((p) => (
          <li key={p.id}>
            <Button onClick={() => setPack({ id: p.id, name: p.name })} data-testid={`pick-pack-${p.name}`}>
              {p.name}
            </Button>{' '}
            <span className="text-xs text-muted">
              {p.personaCount} persona{p.personaCount === 1 ? '' : 's'}
              {p.visibility === 'private' ? ', private to you' : ''}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
