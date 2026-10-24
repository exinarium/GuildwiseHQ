import { UserPlus } from 'lucide-react';
import { useHire } from '../../api/queries/agents.ts';
import { useMyWorkstations } from '../../lib/session.ts';
import { Button, Callout, ErrorBox } from '../ui.tsx';

/**
 * The organization has no BA: recommend hiring one, with a one-click hire of the built-in `ba` role on the user's first
 * online workstation. The hand-off waits and starts on its own once the BA is online.
 */
export function HireBa({ canHire }: { canHire: boolean }) {
  const hire = useHire();
  const ws = useMyWorkstations();
  const station = ws.list.find((w) => w.connected) ?? ws.list[0];
  return (
    <Callout tone="warning" role="status" title="Your organization has no BA yet" data-testid="hire-ba">
      <p>
        The intake is a conversation with a business analyst. We recommend hiring one: the PRD waits and the
        intake starts on its own as soon as the BA's workstation is online.
      </p>
      {canHire && (
        <div className="mt-2">
          <Button
            size="sm"
            variant="primary"
            disabled={!station || hire.isSuccess}
            loading={hire.isPending}
            data-testid="hire-ba-button"
            onClick={() =>
              station &&
              hire.mutate({
                name: 'BA',
                roleKey: 'ba',
                seniority: 'junior',
                workstationId: station.id,
                capacity: 1,
              })
            }
          >
            <UserPlus aria-hidden="true" className="size-4" />
            {hire.isSuccess ? 'BA hired' : 'Hire a BA'}
          </Button>
          {!station && <p className="mt-1 text-xs text-muted">Connect a workstation first.</p>}
        </div>
      )}
      <ErrorBox error={hire.error} />
    </Callout>
  );
}
