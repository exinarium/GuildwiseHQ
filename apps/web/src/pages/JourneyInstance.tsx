import { useParams } from 'react-router';
import { Link, useNavigate } from 'react-router';
import { errorMessage } from '../api/client.ts';
import {
  useCancelJourneyInstance,
  useContinueJourneyStep,
  useJourneyInstance,
  useRunJourneyPlaybook,
} from '../api/queries/journeys.ts';
import { InstanceWaitPanel } from '../components/journeys/InstanceWaitPanel.tsx';
import { InstanceHistory } from '../components/journeys/InstanceHistory.tsx';
import { Badge, Button, Callout, ErrorBox, PageHeader, PageSkeleton, Panel, useToast } from '../components/ui.tsx';

const STATUS_TONE = { running: 'info', waiting: 'warning', stuck: 'danger', completed: 'success', cancelled: 'neutral' } as const;

/** One running (or finished) journey on a record: where it is, what can be done, and the history. */
export function JourneyInstance() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const q = useJourneyInstance(id);
  const cont = useContinueJourneyStep(id ?? '');
  const cancel = useCancelJourneyInstance(id ?? '');
  const playbook = useRunJourneyPlaybook(id ?? '');
  if (q.isLoading) return <PageSkeleton />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => void q.refetch()} />;
  const v = q.data;
  const active = v.status !== 'completed' && v.status !== 'cancelled';
  const step = v.definition.steps.find((s) => s.id === v.currentStepId);
  const run = v.history.find((h) => h.visit === v.currentVisit);
  const fail = (e: unknown) => toast.error(errorMessage(e));

  return (
    <div>
      <PageHeader
        title={v.record.displayName}
        back={{ to: '/journeys', label: 'Journeys' }}
        sub={
          <>
            <Link className="underline" to={`/journeys/${v.journeyId}`}>
              {v.journeyName}
            </Link>{' '}
            · {v.record.type}
            {v.record.externalId ? ` · ${v.record.externalId}` : ''}
          </>
        }
        actions={<Badge tone={STATUS_TONE[v.status]}>{v.status}</Badge>}
      />
      {v.status === 'stuck' && (
        <Callout tone="danger" title="This journey is stuck" className="mb-4" role="alert">
          A step could not start or no handoff matched. A notice is on the desk. Fix the cause, or cancel the instance.
        </Callout>
      )}
      <Panel title={active ? `Now: ${step?.label ?? v.currentStepId}` : 'Finished'} className="mb-4">
        <div className="flex flex-wrap gap-2">
          {active && step && step.kind !== 'workflow' && run?.status === 'waiting' && (
            <Button loading={cont.isPending} onClick={() => cont.mutate({ visit: v.currentVisit }, { onError: fail })}>
              Continue past this step
            </Button>
          )}
          {active && step?.kind === 'workflow' && step.playbook && (
            <Button
              variant="secondary"
              loading={playbook.isPending}
              onClick={() =>
                playbook.mutate(
                  { visit: v.currentVisit },
                  { onSuccess: (r) => nav(r.path), onError: fail },
                )
              }
            >
              Run playbook: {step.playbook.name || step.playbook.key}
            </Button>
          )}
          {active && (
            <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate(undefined, { onError: fail })}>
              Cancel journey
            </Button>
          )}
        </div>
      </Panel>
      <Panel title="Waits, approvals and calls" className="mb-4">
        <InstanceWaitPanel instanceId={v.id} def={v.definition} active={active} />
        <p className="text-sm text-muted empty:hidden">Every wait shows its deadline here, and every timeout leaves a line.</p>
      </Panel>
      <Panel title="History" className="mb-4">
        <InstanceHistory history={v.history} />
      </Panel>
      <Panel title="References">
        {v.record.references.length === 0 ? (
          <p className="text-sm text-muted">No documents, form submissions or cards yet.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {v.record.references.map((r) => (
              <li key={`${r.kind}-${r.ref}`} className="[overflow-wrap:anywhere]">
                <Badge tone="neutral">{r.kind.replace('_', ' ')}</Badge> {r.label ?? ''} <span className="text-muted">{r.ref}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
