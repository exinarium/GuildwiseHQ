import { useState } from 'react';
import { useHirablePacks } from '../../api/queries/my-capabilities.ts';
import { Button, Dialog, EmptyState, ErrorBox, ListSkeleton } from '../ui.tsx';
import { HirePackDialog } from './HirePackDialog.tsx';

/** From the HR board: choose an approved pack, then the personas of it to hire. */
export function PickPackToHire({ onClose }: { onClose: () => void }) {
  // Owners, Admins and Members alike: the approved packs with personas (a member's hire is bound to a project they are on)
  const q = useHirablePacks();
  const [pack, setPack] = useState<{ id: string; name: string } | null>(null);
  if (pack) return <HirePackDialog packId={pack.id} packName={pack.name} onClose={onClose} />;
  const trusted = q.data?.packs ?? [];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Hire from a pack"
      description="Personas of an approved pack become agents with a tag that says where they came from."
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
          title="No approved pack yet"
          description="An Owner or Admin adds a pack under Settings > Capabilities and approves it; your own private packs are listed too."
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
