import { type CardDetailResponse, fieldCatalogue, type WorkflowDefinition } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useParams } from 'react-router';
import { useWorkflows } from '../api/queries/agents.ts';
import {
  missingFromError,
  useCancelCard,
  useCard,
  useComment,
  useMoveCard,
  useReleaseCard,
  useSpecifyCard,
} from '../api/queries/cards.ts';
import { ShiftLog } from '../components/ShiftLog.tsx';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  ErrorBox,
  PageHeader,
  Panel,
  Select,
  Spinner,
  TextArea,
} from '../components/ui.tsx';
import { fieldLabel } from '../lib/cardForm.ts';
import { formatDateTime } from '../lib/time.ts';

function renderValue(v: unknown) {
  if (Array.isArray(v)) {
    return (
      <ul className="list-disc pl-5">
        {v.map((x, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static display list
          <li key={i}>{typeof x === 'string' ? x : JSON.stringify(x)}</li>
        ))}
      </ul>
    );
  }
  if (typeof v === 'object' && v !== null) {
    return <pre className="overflow-x-auto font-mono text-xs">{JSON.stringify(v, null, 2)}</pre>;
  }
  return <p className="whitespace-pre-wrap">{String(v)}</p>;
}

function statusTone(status: string) {
  if (status === 'blocked') return 'red' as const;
  if (status === 'claimed') return 'blue' as const;
  if (status === 'done') return 'green' as const;
  if (status === 'waiting') return 'amber' as const;
  return 'neutral' as const;
}

export function CardDetail() {
  const { ref = '' } = useParams();
  const q = useCard(ref);
  const workflows = useWorkflows();
  if (q.isPending) return <Spinner label="Loading card" />;
  if (q.isError) {
    return (
      <div>
        <PageHeader title="Card" />
        <ErrorBox error={q.error} />
      </div>
    );
  }
  const candidates = (workflows.data ?? [])
    .map((w) => w.definition)
    .filter((d) => d.key === q.data.card.workflowKey)
    .sort((x, y) => y.version - x.version);
  const wf = candidates.find((d) => d.version === q.data.card.workflowVersion) ?? candidates[0];
  return <CardDetailView data={q.data} workflow={wf} />;
}

export function CardDetailView({
  data,
  workflow,
}: {
  data: CardDetailResponse;
  workflow: WorkflowDefinition | undefined;
}) {
  const { card, handoffs, transitions, thread, currentShift, permissions } = data;
  const specify = useSpecifyCard(card.id);
  const release = useReleaseCard(card.id);
  const [dialog, setDialog] = useState<'move' | 'cancel' | null>(null);
  const missing = missingFromError(specify.error);
  const catalogue = workflow ? fieldCatalogue(workflow.fieldSet, workflow.customFields) : {};
  const keys = Object.keys(card.fields);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={`${card.ref} ${card.title}`}
        sub={
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={statusTone(card.status)}>{card.status}</Badge>
            <span data-testid="card-column">{card.column}</span>
            <span>· {card.cardType}</span>
            {card.reworkRound > 0 && <Badge tone="violet">Rework {card.reworkRound}</Badge>}
            {card.claimedByAgentName && (
              <span className="inline-flex items-center gap-1">
                <Avatar name={card.claimedByAgentName} size={18} />
                {card.claimedByAgentName}
              </span>
            )}
          </span>
        }
        actions={
          <>
            {permissions.canSpecify && card.status === 'draft' && (
              <Button
                variant="primary"
                disabled={specify.isPending}
                onClick={() => specify.mutate(undefined)}
              >
                Specify
              </Button>
            )}
            {permissions.canMove && <Button onClick={() => setDialog('move')}>Move</Button>}
            {permissions.canRelease && card.status === 'claimed' && (
              <Button disabled={release.isPending} onClick={() => release.mutate(undefined)}>
                Release
              </Button>
            )}
            {permissions.canCancel && card.status !== 'cancelled' && card.status !== 'done' && (
              <Button variant="danger" onClick={() => setDialog('cancel')}>
                Cancel card
              </Button>
            )}
          </>
        }
      />
      {missing.length > 0 && (
        <p role="alert" className="mb-3 text-sm font-medium text-red-600 dark:text-red-400">
          Cannot specify yet. Missing:{' '}
          {missing.map((m) => (workflow ? fieldLabel(workflow, m) : m)).join(', ')}
        </p>
      )}
      {!missing.length && <ErrorBox error={specify.error ?? release.error} />}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          {currentShift && currentShift.status !== 'ended' && (
            <Panel>
              <h2 className="mb-2 text-sm font-semibold">
                Live shift{currentShift.agentName ? ` · ${currentShift.agentName}` : ''}
                <span className="ml-2 font-normal text-zinc-500">{currentShift.stage}</span>
              </h2>
              <ShiftLog key={currentShift.id} shift={currentShift} />
            </Panel>
          )}
          <Panel>
            <h2 className="mb-2 text-sm font-semibold">Details</h2>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
              <Meta k="Stage" v={card.stage} />
              <Meta k="Risk tier" v={card.riskTier ?? 'not set'} />
              <Meta k="Completion action" v={card.completionAction ?? 'not set'} />
              <Meta k="Docs needed" v={card.docsNeeded ? 'yes' : 'no'} />
              {card.branchName && <Meta k="Branch" v={card.branchName} mono />}
              <Meta k="Priority" v={String(card.priority)} />
            </dl>
            {keys.length > 0 && (
              <dl className="mt-3 flex flex-col gap-3 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800">
                {keys.map((k) => (
                  <div key={k}>
                    <dt className="text-xs font-medium text-zinc-500">{catalogue[k]?.label ?? k}</dt>
                    <dd className="mt-0.5">{renderValue(card.fields[k])}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>
          <Panel>
            <h2 className="mb-2 text-sm font-semibold">Handoffs ({handoffs.length})</h2>
            {handoffs.length === 0 && <p className="text-sm text-zinc-500">No handoffs yet.</p>}
            <ol className="flex flex-col gap-2" data-testid="handoffs">
              {handoffs.map((h) => (
                <li
                  key={h.id}
                  data-testid="handoff"
                  data-stage={h.stage}
                  data-outcome={h.outcome}
                  className="rounded-md border border-zinc-200 p-2 text-sm dark:border-zinc-800"
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                    {h.agentName && <Avatar name={h.agentName} size={18} />}
                    <span>{h.agentName ?? 'system'}</span>
                    <Badge tone={h.outcome === 'changes' || h.outcome === 'fail' ? 'red' : 'green'}>
                      {h.stage}: {h.outcome}
                    </Badge>
                    <span>{formatDateTime(h.createdAt)}</span>
                  </div>
                  {h.note && <p className="mt-1 whitespace-pre-wrap">{h.note}</p>}
                  <HandoffData data={h.data} />
                </li>
              ))}
            </ol>
          </Panel>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <Panel>
            <h2 className="mb-2 text-sm font-semibold">Timeline</h2>
            <ol className="flex flex-col gap-1.5 text-sm" data-testid="timeline">
              {transitions.map((t) => (
                <li key={t.id} className="flex flex-col">
                  <span>
                    <span className="font-medium">{t.fromStage ?? 'new'}</span> →{' '}
                    <span className="font-medium">{t.toStage}</span>{' '}
                    <span className="text-xs text-zinc-500">({t.toStatus})</span>
                  </span>
                  <span className="text-xs text-zinc-500">
                    {t.reason} · {formatDateTime(t.at)}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
          <ThreadPanel cardId={card.id} thread={thread} canComment={permissions.canComment} />
        </div>
      </div>

      {workflow && (
        <MoveDialog
          open={dialog === 'move'}
          onOpenChange={(o) => !o && setDialog(null)}
          cardId={card.id}
          workflow={workflow}
          current={card.stage}
        />
      )}
      <CancelDialog open={dialog === 'cancel'} onOpenChange={(o) => !o && setDialog(null)} cardId={card.id} />
    </div>
  );
}

function Meta({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-zinc-500">{k}</dt>
      <dd className={mono ? 'font-mono text-xs break-all' : ''}>{v}</dd>
    </div>
  );
}

function HandoffData({ data }: { data: Record<string, unknown> }) {
  const reasons = Array.isArray(data.reasons) ? (data.reasons as string[]) : [];
  const missed = Array.isArray(data.criteriaMissed) ? (data.criteriaMissed as string[]) : [];
  const score = typeof data.score === 'number' ? data.score : null;
  if (!reasons.length && !missed.length && score === null) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs" data-testid="handoff-review">
      {score !== null && <Badge>Score {score}/5</Badge>}
      {reasons.map((r) => (
        <Badge key={r} tone="red">
          {r.replaceAll('_', ' ')}
        </Badge>
      ))}
      {missed.map((m) => (
        <span key={m} className="text-zinc-500">
          Missed: {m}
        </span>
      ))}
    </div>
  );
}

function ThreadPanel({
  cardId,
  thread,
  canComment,
}: {
  cardId: string;
  thread: CardDetailResponse['thread'];
  canComment: boolean;
}) {
  const comment = useComment(cardId);
  const [body, setBody] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    comment.mutate(body.trim(), { onSuccess: () => setBody('') });
  };
  return (
    <Panel>
      <h2 className="mb-2 text-sm font-semibold">Thread</h2>
      <ul className="flex flex-col gap-2" data-testid="thread">
        {thread.length === 0 && <li className="text-sm text-zinc-500">No messages yet.</li>}
        {thread.map((m) => (
          <li key={m.id} className="text-sm">
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              {m.authorName && <Avatar name={m.authorName} size={16} />}
              <span className="font-medium">{m.authorName ?? m.authorKind}</span>
              <Badge>{m.kind}</Badge>
              <span>{formatDateTime(m.createdAt)}</span>
            </div>
            <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>
          </li>
        ))}
      </ul>
      {canComment && (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-2" aria-label="Add comment">
          <TextArea label="Comment" value={body} onChange={(e) => setBody(e.target.value)} />
          <ErrorBox error={comment.error} />
          <Button
            type="submit"
            variant="primary"
            disabled={!body.trim() || comment.isPending}
            className="self-start"
          >
            Post comment
          </Button>
        </form>
      )}
    </Panel>
  );
}

function MoveDialog({
  open,
  onOpenChange,
  cardId,
  workflow,
  current,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cardId: string;
  workflow: WorkflowDefinition;
  current: string;
}) {
  const move = useMoveCard(cardId);
  const [toStage, setToStage] = useState(current);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setErr('A reason is required');
    setErr('');
    move.mutate(
      { toStage, reason: reason.trim() },
      {
        onSuccess: () => {
          setReason('');
          onOpenChange(false);
        },
      },
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Move card"
      description="Override the workflow and move this card to another stage."
    >
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <Select label="Target stage" value={toStage} onChange={(e) => setToStage(e.target.value)}>
          {workflow.stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={err} />
        <ErrorBox error={move.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button type="submit" variant="primary" disabled={move.isPending}>
            Move card
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CancelDialog({
  open,
  onOpenChange,
  cardId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cardId: string;
}) {
  const cancel = useCancelCard(cardId);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return setErr('A reason is required');
    setErr('');
    cancel.mutate(reason.trim(), { onSuccess: () => onOpenChange(false) });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Cancel card"
      description="The card leaves the board. Any active claim is released."
    >
      <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
        <TextArea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={err} />
        <ErrorBox error={cancel.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Keep card</Button>
          <Button type="submit" variant="danger" disabled={cancel.isPending}>
            Confirm cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
