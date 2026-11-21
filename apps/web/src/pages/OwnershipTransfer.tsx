import { useParams } from 'react-router';
import { useDecideOwnershipTransfer, useOwnershipTransfer } from '../api/queries/leastPrivilege.ts';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
} from '../components/ui.tsx';
import { formatDateTime } from '../lib/time.ts';
import { usePageTitle } from '../lib/usePageTitle.ts';

/**
 * `/org-transfer/:id`: the Owner's consent page for an ownership transfer Guildwise support asked for (R17-3). Approve
 * asks "Confirm it's you" first; veto stops it. Only the organization's current Owner sees it.
 */
export function OwnershipTransfer() {
  usePageTitle('Ownership transfer');
  const { id = '' } = useParams();
  const t = useOwnershipTransfer(id);
  const decide = useDecideOwnershipTransfer(id);

  if (t.isPending) return <PageSkeleton label="Loading the transfer" />;
  if (t.isError || !t.data)
    return (
      <EmptyState
        title="Transfer not found"
        description="Only the Owner of the organization sees this page. Sign in with the Owner's account."
      />
    );
  const x = t.data;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <PageHeader title="Ownership transfer" sub={x.orgName} />
      <Panel>
        <div className="flex flex-col gap-3 text-sm" data-testid="ownership-transfer">
          <p>
            Guildwise support asked to make <strong>{x.toUser.displayName}</strong> ({x.toUser.email}) the
            Owner of <strong>{x.orgName}</strong>. You would become an Admin.
          </p>
          {x.reason && (
            <p>
              <span className="text-subtle">Reason given:</span> {x.reason}
            </p>
          )}
          <p className="text-subtle">Requested {formatDateTime(x.requestedAt)}</p>
          {x.decision ? (
            <p>
              <Badge
                tone={x.decision === 'vetoed' ? 'warning' : 'success'}
                data-testid="ownership-transfer-decision"
              >
                {x.decision}
              </Badge>{' '}
              {x.decidedAt && formatDateTime(x.decidedAt)}
            </p>
          ) : (
            <>
              <Callout tone={x.automatic ? 'warning' : 'info'}>
                {x.automatic
                  ? `If you do nothing, it takes effect ${formatDateTime(x.effectiveAt)}. Veto it if you did not expect it.`
                  : 'Your organization has deploy targets, so nothing happens unless you approve it.'}
              </Callout>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  loading={decide.isPending && decide.variables === 'approve'}
                  onClick={() => decide.mutate('approve')}
                  data-testid="ownership-transfer-approve"
                >
                  Approve the transfer
                </Button>
                <Button
                  variant="danger"
                  loading={decide.isPending && decide.variables === 'veto'}
                  onClick={() => decide.mutate('veto')}
                  data-testid="ownership-transfer-veto"
                >
                  Veto
                </Button>
              </div>
            </>
          )}
          <ErrorBox error={decide.error} />
        </div>
      </Panel>
    </div>
  );
}
