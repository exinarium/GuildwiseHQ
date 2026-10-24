import { useDecideAssignment, usePackAssignments } from '../../api/queries/my-capabilities.ts';
import { Button, Callout, ErrorBox } from '../ui.tsx';

/**
 * A pack an Owner or Admin wants on one of your workstations. Nothing is downloaded until you accept; declining removes the
 * assignment. The same request is on your desk.
 */
export function PackAssignments() {
  const q = usePackAssignments();
  const decide = useDecideAssignment();
  const items = q.data ?? [];
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="pack-assignments">
      {items.map((a) => (
        <Callout
          key={`${a.packId}:${a.workstationId}`}
          tone="info"
          title={`Allow the pack "${a.packName}" on ${a.workstationName}?`}
          data-testid={`assignment-${a.packName}`}
          actions={
            <>
              <Button
                size="sm"
                variant="primary"
                loading={decide.isPending}
                onClick={() =>
                  decide.mutate({ packId: a.packId, workstationId: a.workstationId, accept: true })
                }
              >
                Accept
              </Button>
              <Button
                size="sm"
                loading={decide.isPending}
                onClick={() =>
                  decide.mutate({ packId: a.packId, workstationId: a.workstationId, accept: false })
                }
              >
                Decline
              </Button>
            </>
          }
        >
          {a.requestedByName ?? 'An admin'} asked to put it on this workstation ({a.url}).
          {a.private &&
            ' The repository is private: a deploy key or token was sealed for this workstation and stays on it.'}{' '}
          Nothing is downloaded until you accept.
        </Callout>
      ))}
      <ErrorBox error={decide.error} />
    </div>
  );
}
